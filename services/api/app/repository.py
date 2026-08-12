from __future__ import annotations

import json
import re
from uuid import uuid4

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from .models import Conversation, ConversationMessage, Project, ProjectPrompt, Task, TaskApproval, TaskEvent, TaskRun, TaskTurn
from .schemas import (
    AddConversationMessageRequest,
    ConversationDetail,
    ConversationMessageItem,
    ConversationSummary,
    CreateConversationRequest,
    CreateProjectPromptRequest,
    CreateProjectRequest,
    CreateTaskRequest,
    PendingInteractionType,
    ProjectPromptItem,
    ProjectSummary,
    RuntimeEvent,
    SessionRun,
    SessionTurn,
    TaskApprovalResponse,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskSummary,
    UpdateProjectPromptRequest,
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
    stmt = select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created_at.desc())
    return list(db.scalars(stmt))


def get_project(db: Session, project_id: str) -> Project | None:
    stmt = select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    return db.scalars(stmt).first()


def get_project_any(db: Session, project_id: str) -> Project | None:
    return db.get(Project, project_id)


def soft_delete_project(db: Session, project_id: str) -> None:
    db.execute(
        update(Project)
        .where(Project.id == project_id, Project.deleted_at.is_(None))
        .values(deleted_at=func.current_timestamp())
    )
    db.commit()


def list_project_prompts(db: Session, project_id: str) -> list[ProjectPrompt]:
    stmt = (
        select(ProjectPrompt)
        .where(ProjectPrompt.project_id == project_id)
        .order_by(ProjectPrompt.position, ProjectPrompt.created_at)
    )
    return list(db.scalars(stmt))


def get_project_prompt(db: Session, prompt_id: str) -> ProjectPrompt | None:
    return db.get(ProjectPrompt, prompt_id)


def create_project_prompt(db: Session, project_id: str, payload: CreateProjectPromptRequest) -> ProjectPrompt:
    next_position = db.scalar(
        select(func.max(ProjectPrompt.position)).where(ProjectPrompt.project_id == project_id)
    )
    prompt = ProjectPrompt(
        project_id=project_id,
        title=payload.title,
        content=payload.content,
        position=(next_position or 0) + 1,
    )
    db.add(prompt)
    db.commit()
    db.refresh(prompt)
    return prompt


def update_project_prompt(db: Session, prompt: ProjectPrompt, payload: UpdateProjectPromptRequest) -> ProjectPrompt:
    if payload.title is not None:
        prompt.title = payload.title
    if payload.content is not None:
        prompt.content = payload.content
    db.add(prompt)
    db.commit()
    db.refresh(prompt)
    return prompt


def delete_project_prompt(db: Session, prompt_id: str) -> None:
    prompt = db.get(ProjectPrompt, prompt_id)
    if prompt:
        db.delete(prompt)
        db.commit()


def create_task(db: Session, payload: CreateTaskRequest) -> Task:
    task = Task(
        project_id=payload.project_id,
        title=payload.title,
        prompt=payload.prompt,
        execution_mode=payload.execution_mode,
        engine=payload.engine,
        model=payload.model,
        profile=payload.profile,
        reasoning_effort=payload.reasoning_effort,
        workspace_type=payload.workspace_type,
        workspace_ref=build_workspace_ref(payload.title),
        workspace_path=None,
        status="queued",
    )
    db.add(task)
    db.commit()
    created = get_task(db, task.id)
    if created is None:
        raise RuntimeError("Task creation failed")
    create_turn(db, created, role="user", content=payload.prompt)
    return get_task(db, task.id)


def list_tasks(db: Session, project_id: str) -> list[Task]:
    return list(db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.created_at.desc())))


def get_task(db: Session, task_id: str) -> Task | None:
    stmt = (
        select(Task)
        .where(Task.id == task_id)
        .options(
            selectinload(Task.project),
            selectinload(Task.approvals),
            selectinload(Task.events),
            selectinload(Task.turns),
            selectinload(Task.runs),
        )
    )
    return db.scalars(stmt).first()


def delete_task(db: Session, task_id: str) -> None:
    task = db.get(Task, task_id)
    if task:
        db.delete(task)
        db.commit()


def session_id_for_task(task: Task) -> str:
    return task.id


def get_task_by_session_id(db: Session, session_id: str) -> Task | None:
    return get_task(db, session_id)


def create_turn(db: Session, task: Task, role: str, content: str) -> TaskTurn:
    turn = TaskTurn(
        session_id=session_id_for_task(task),
        task_id=task.id,
        role=role,
        content=content,
    )
    db.add(turn)
    db.commit()
    db.refresh(turn)
    return turn


def list_turns(db: Session, task_id: str) -> list[TaskTurn]:
    stmt = select(TaskTurn).where(TaskTurn.task_id == task_id).order_by(TaskTurn.created_at.asc())
    return list(db.scalars(stmt))


def get_latest_run(db: Session, task_id: str) -> TaskRun | None:
    stmt = select(TaskRun).where(TaskRun.task_id == task_id).order_by(TaskRun.created_at.desc())
    return db.scalars(stmt).first()


def create_run(db: Session, task: Task, input_text: str, parent_run_id: str | None = None) -> TaskRun:
    run = TaskRun(
        session_id=session_id_for_task(task),
        task_id=task.id,
        parent_run_id=parent_run_id,
        status="running",
        input=input_text,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def update_latest_run_status(db: Session, task: Task, task_status: str) -> None:
    latest = get_latest_run(db, task.id)
    if latest is None:
        return
    if task_status == "completed":
        latest.status = "completed"
    elif task_status in {"failed", "stopped"}:
        latest.status = "failed"
    else:
        latest.status = "running"
    db.add(latest)


def set_task_status(
    db: Session,
    task: Task,
    status: str,
    runtime_session_id: str | None = None,
    effective_model: str | None = None,
) -> Task:
    task.status = status
    if runtime_session_id is not None:
        task.runtime_session_id = runtime_session_id
    if effective_model is not None:
        task.effective_model = effective_model
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
        terminal_statuses = {"completed", "failed", "stopped"}
        if task.status in terminal_statuses and status not in terminal_statuses:
            # Keep terminal task states stable even if late runtime activity events arrive.
            pass
        elif status == "running" and task.status in {"waiting_user_input", "waiting_result_approval"}:
            payload = event.payload or {}
            can_leave_waiting = (
                record.type in {"user_input_submitted", "result_approval_granted"}
                or (record.type == "agent_status" and payload.get("cleanup_pending_snapshot"))
            )
            if can_leave_waiting:
                task.status = status
        else:
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
    if (
        record.type == "agent_status"
        and event.payload
        and event.payload.get("source") == "agent_message"
    ):
        conv = db.scalars(select(Conversation).where(Conversation.task_id == task.id)).first()
        if conv:
            full_content = event.payload.get("full_content") or event.message
            assistant_msg = ConversationMessage(
                conversation_id=conv.id,
                role="assistant",
                content=full_content,
            )
            db.add(assistant_msg)
            db.execute(
                update(Conversation)
                .where(Conversation.id == conv.id)
                .values(updated_at=func.current_timestamp())
            )
    update_latest_run_status(db, task, task.status)
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


def serialize_project_prompt(prompt: ProjectPrompt) -> ProjectPromptItem:
    return ProjectPromptItem.model_validate(prompt, from_attributes=True)


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


def create_conversation(db: Session, payload: CreateConversationRequest) -> Conversation:
    conv = Conversation(title=payload.title, project_id=payload.project_id)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def list_conversations(db: Session) -> list[Conversation]:
    stmt = (
        select(Conversation)
        .options(
            selectinload(Conversation.project),
            selectinload(Conversation.messages),
            selectinload(Conversation.task),
        )
        .order_by(Conversation.updated_at.desc())
    )
    return list(db.scalars(stmt))


def get_conversation(db: Session, conversation_id: str) -> Conversation | None:
    stmt = (
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .options(
            selectinload(Conversation.messages),
            selectinload(Conversation.project),
            selectinload(Conversation.task).selectinload(Task.project),
        )
    )
    return db.scalars(stmt).first()


def delete_conversation(db: Session, conversation_id: str) -> None:
    conv = db.get(Conversation, conversation_id)
    if conv:
        db.delete(conv)
        db.commit()


def set_conversation_task_id(db: Session, conversation_id: str, task_id: str) -> None:
    db.execute(update(Conversation).where(Conversation.id == conversation_id).values(task_id=task_id))
    db.commit()


def add_conversation_message(
    db: Session, conversation_id: str, payload: AddConversationMessageRequest
) -> ConversationMessage:
    msg = ConversationMessage(
        conversation_id=conversation_id,
        role=payload.role,
        content=payload.content,
    )
    db.add(msg)
    conv = db.get(Conversation, conversation_id)
    if conv:
        if not conv.messages and conv.title == "New Conversation":
            conv.title = payload.content[:50].strip() or "New Conversation"
        db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(updated_at=func.current_timestamp(), title=conv.title)
        )
    db.commit()
    db.refresh(msg)
    return msg


def serialize_conversation_message(msg: ConversationMessage) -> ConversationMessageItem:
    return ConversationMessageItem(
        id=msg.id,
        conversation_id=msg.conversation_id,
        role=msg.role,
        content=msg.content,
        created_at=msg.created_at,
    )


def serialize_conversation_summary(conv: Conversation) -> ConversationSummary:
    last_message = conv.messages[-1].content if conv.messages else None
    task_status = conv.task.status if conv.task else None
    return ConversationSummary(
        id=conv.id,
        title=conv.title,
        last_message=last_message,
        project_id=conv.project_id,
        project_name=conv.project.name if conv.project else None,
        task_id=conv.task_id,
        task_status=task_status,  # type: ignore[arg-type]
        updated_at=conv.updated_at,
    )


def serialize_conversation_detail(conv: Conversation) -> ConversationDetail:
    task = conv.task
    return ConversationDetail(
        id=conv.id,
        title=conv.title,
        project_id=conv.project_id,
        project_name=conv.project.name if conv.project else None,
        task_id=conv.task_id,
        task_status=task.status if task else None,  # type: ignore[arg-type]
        task_workspace_ref=task.workspace_ref if task else None,
        task_base_branch=task.project.default_branch if task and task.project else None,
        task_model=task.effective_model or task.model if task else None,
        task_profile=task.profile if task else None,
        task_engine=task.engine if task else None,
        messages=[serialize_conversation_message(msg) for msg in conv.messages],
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )


def serialize_task_detail(task: Task) -> TaskDetail:
    pending_payload = json.loads(task.pending_request_payload_json) if task.pending_request_payload_json else None
    return TaskDetail(
        **serialize_task_summary(task).model_dump(),
        prompt=task.prompt,
        session_id=session_id_for_task(task),
        turns=[serialize_turn(item) for item in sorted(task.turns, key=lambda turn: turn.created_at)],
        runs=[serialize_run(item) for item in sorted(task.runs, key=lambda run: run.created_at)],
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


def serialize_turn(turn: TaskTurn) -> SessionTurn:
    return SessionTurn(
        id=turn.id,
        session_id=turn.session_id,
        role=turn.role,  # type: ignore[arg-type]
        content=turn.content,
        created_at=turn.created_at,
    )


def serialize_run(run: TaskRun) -> SessionRun:
    return SessionRun(
        id=run.id,
        session_id=run.session_id,
        parent_run_id=run.parent_run_id,
        status=run.status,  # type: ignore[arg-type]
        input=run.input,
        created_at=run.created_at,
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
