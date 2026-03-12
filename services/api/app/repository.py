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
    if action == "approve":
        task.status = "approved"
    elif action == "stop":
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
        "waiting_approval",
        "test_result",
        "completed",
        "failed",
        "stopped",
    }
    return event_type if event_type in supported else "agent_status"


def map_status_from_event(event_type: str) -> str | None:
    return {
        "waiting_approval": "waiting_approval",
        "completed": "completed",
        "failed": "failed",
        "stopped": "stopped",
    }.get(event_type, "running" if event_type in {"agent_status", "file_changed", "command_executed", "diff_generated", "test_result"} else None)


def can_approve(status: str) -> bool:
    return status in {"running", "waiting_approval"}


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
    return TaskEventResponse(
        id=record.id,
        task_id=record.task_id,
        seq=record.seq,
        type=record.type,  # type: ignore[arg-type]
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
    return TaskDetail(
        **serialize_task_summary(task).model_dump(),
        prompt=task.prompt,
        project=serialize_project(task.project),
        approvals=[
            TaskApprovalResponse(action=item.action, actor=item.actor, created_at=item.created_at)
            for item in task.approvals
        ],
        latest_diff=serialize_diff(task),
    )
