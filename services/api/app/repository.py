from __future__ import annotations

import json
import re
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .models import Project, Task, TaskApproval, TaskEvent
from .schemas import (
    CreateProjectRequest,
    CreateTaskRequest,
    PendingInteractionType,
    ProjectSummary,
    RuntimeEvent,
    TaskApprovalResponse,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskSummary,
)


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "task"


def build_workspace_ref(title: str) -> str:
    return f"task/{slugify(title)}-{str(uuid4())[:4]}"


def create_project(db: Session, payload: CreateProjectRequest) -> Project:
    project = Project(
        name=payload.name,
        repo_path=payload.repo_path,
        default_branch=payload.default_branch,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def list_projects(db: Session) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.created_at.desc())))


def get_project(db: Session, project_id: str) -> Project | None:
    return db.get(Project, project_id)


def create_task(db: Session, payload: CreateTaskRequest) -> Task:
    task = Task(
        project_id=payload.project_id,
        title=payload.title,
        prompt=payload.prompt,
        execution_mode=payload.execution_mode,
        workspace_type=payload.workspace_type,
        workspace_ref=build_workspace_ref(payload.title),
        workspace_path=None,
        status="queued",
    )
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def list_tasks(db: Session, project_id: str) -> list[Task]:
    return list(db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.created_at.desc())))


def get_task(db: Session, task_id: str) -> Task | None:
    stmt = (
        select(Task)
        .where(Task.id == task_id)
        .options(selectinload(Task.project), selectinload(Task.approvals), selectinload(Task.events))
    )
    return db.scalars(stmt).first()


def set_task_status(db: Session, task: Task, status: str, runtime_session_id: str | None = None) -> Task:
    task.status = status
    if runtime_session_id is not None:
        task.runtime_session_id = runtime_session_id
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def clear_runtime_session(db: Session, task: Task, status: str = "failed") -> Task:
    task.status = status
    task.runtime_session_id = None
    task.pending_interaction_type = None
    task.pending_request_id = None
    task.pending_request_payload_json = None
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def set_task_workspace(db: Session, task: Task, workspace_path: str) -> Task:
    task.workspace_path = workspace_path
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def append_event(db: Session, task: Task, event: RuntimeEvent) -> TaskEvent:
    next_seq = db.scalar(select(func.max(TaskEvent.seq)).where(TaskEvent.task_id == task.id)) or 0
    record = TaskEvent(
        task_id=task.id,
        seq=next_seq + 1,
        type=normalize_event_type(event.type),
        message=event.message,
        payload_json=json.dumps(event.payload) if event.payload is not None else None,
    )
    db.add(record)
    status = map_status_from_event(record.type)
    if status:
        task.status = status
    if record.type in {"user_input_requested", "result_approval_requested"}:
        payload = event.payload or {}
        task.pending_interaction_type = (
            "user_input" if record.type == "user_input_requested" else "result_approval"
        )
        task.pending_request_id = str(payload.get("request_id")) if payload.get("request_id") is not None else None
        task.pending_request_payload_json = json.dumps(payload)
    elif record.type in {"user_input_submitted", "result_approval_granted"} or (
        record.type == "agent_status" and (event.payload or {}).get("cleanup_pending_snapshot")
    ):
        task.pending_interaction_type = None
        task.pending_request_id = None
        task.pending_request_payload_json = None
    if record.type == "diff_generated" and event.payload is not None:
        task.latest_diff_summary = str(event.payload.get("summary") or task.latest_diff_summary or event.message)
        files = event.payload.get("files_changed", [])
        task.latest_diff_files_json = json.dumps(files)
        task.latest_diff_raw = event.payload.get("raw_diff")
    db.add(task)
    db.commit()
    db.refresh(record)
    return record


def replace_diff(db: Session, task: Task, diff: TaskDiff) -> Task:
    task.latest_diff_summary = diff.summary
    task.latest_diff_raw = diff.raw_diff
    task.latest_diff_files_json = json.dumps(diff.files_changed)
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def list_events(db: Session, task_id: str) -> list[TaskEvent]:
    stmt = select(TaskEvent).where(TaskEvent.task_id == task_id).order_by(TaskEvent.seq.asc())
    return list(db.scalars(stmt))


def add_approval(db: Session, task: Task, action: str, actor: str) -> TaskApproval:
    approval = TaskApproval(task_id=task.id, action=action, actor=actor)
    db.add(approval)
    if action == "stop":
        task.status = "stopped"
    db.add(task)
    db.commit()
    db.refresh(approval)
    return approval


def normalize_event_type(event_type: str) -> str:
    supported = {
        "agent_status",
        "file_changed",
        "command_executed",
        "diff_generated",
        "test_result",
        "user_input_requested",
        "user_input_submitted",
        "result_approval_requested",
        "result_approval_granted",
        "plan_updated",
        "plan_delta",
        "completed",
        "failed",
        "stopped",
    }
    return event_type if event_type in supported else "agent_status"


def map_status_from_event(event_type: str) -> str | None:
    if event_type == "user_input_requested":
        return "waiting_user_input"
    if event_type == "result_approval_requested":
        return "waiting_result_approval"
    if event_type == "completed":
        return "completed"
    if event_type == "failed":
        return "failed"
    if event_type == "stopped":
        return "stopped"
    if event_type in {
        "agent_status",
        "file_changed",
        "command_executed",
        "diff_generated",
        "test_result",
        "user_input_submitted",
        "result_approval_granted",
        "plan_updated",
        "plan_delta",
    }:
        return "running"
    return None


def can_approve(status: str) -> bool:
    return status == "waiting_result_approval"


def can_stop(status: str) -> bool:
    return status not in {"completed", "failed", "stopped"}


def can_retry(status: str) -> bool:
    return status in {"failed", "stopped", "completed"}


def serialize_project(project: Project) -> ProjectSummary:
    return ProjectSummary.model_validate(project, from_attributes=True)


def serialize_task_summary(task: Task) -> TaskSummary:
    return TaskSummary.model_validate(task, from_attributes=True)


def serialize_event(record: TaskEvent) -> TaskEventResponse:
    payload = json.loads(record.payload_json) if record.payload_json else None
    event_type = canonicalize_legacy_event_type(record.type)
    return TaskEventResponse(
        id=record.id,
        task_id=record.task_id,
        seq=record.seq,
        type=event_type,  # type: ignore[arg-type]
        message=record.message,
        payload_json=payload,
        created_at=record.created_at,
    )


def serialize_diff(task: Task) -> TaskDiff:
    return TaskDiff(
        files_changed=json.loads(task.latest_diff_files_json or "[]"),
        summary=task.latest_diff_summary or "",
        raw_diff=task.latest_diff_raw,
    )


def serialize_task_detail(task: Task) -> TaskDetail:
    pending_payload = json.loads(task.pending_request_payload_json) if task.pending_request_payload_json else None
    return TaskDetail(
        **serialize_task_summary(task).model_dump(),
        prompt=task.prompt,
        project=serialize_project(task.project),
        approvals=[
            TaskApprovalResponse(action=item.action, actor=item.actor, created_at=item.created_at)
            for item in task.approvals
        ],
        latest_diff=serialize_diff(task),
        pending_interaction_type=_normalize_pending_interaction_type(task.pending_interaction_type),
        pending_request_id=task.pending_request_id,
        pending_request_payload_json=pending_payload,
        pending_questions=_serialize_pending_questions(pending_payload),
    )


def _normalize_pending_interaction_type(value: str | None) -> PendingInteractionType | None:
    if value in {"user_input", "result_approval"}:
        return value
    return None


def _serialize_pending_questions(payload: dict | None) -> list[dict]:
    if not payload:
        return []
    raw_questions = payload.get("questions")
    if not isinstance(raw_questions, list):
        return []
    questions: list[dict] = []
    for item in raw_questions:
        if not isinstance(item, dict):
            continue
        options = item.get("options")
        normalized_options = None
        if isinstance(options, list):
            normalized_options = [
                {"label": option.get("label", ""), "description": option.get("description", "")}
                for option in options
                if isinstance(option, dict)
            ]
        questions.append(
            {
                "id": str(item.get("id", "")),
                "header": str(item.get("header", "")),
                "question": str(item.get("question", "")),
                "is_other": bool(item.get("is_other", item.get("isOther", False))),
                "is_secret": bool(item.get("is_secret", item.get("isSecret", False))),
                "options": normalized_options,
            }
        )
    return questions


def canonicalize_legacy_event_type(event_type: str) -> str:
    if event_type == "waiting_approval":
        return "result_approval_requested"
    if event_type == "approved":
        return "result_approval_granted"
    return normalize_event_type(event_type)
