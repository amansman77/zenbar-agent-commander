"""ORM models -> API schemas.

The only place that knows how a persisted row becomes a response body. Kept
together so the read side of the API has one home, and so the JSON-encoded
columns (pending questions, pipeline steps, diff files) are decoded in exactly
one place.
"""

from __future__ import annotations

import json

from ..models import (
    Conversation,
    ConversationMessage,
    GlobalPrompt,
    Project,
    ProjectPipeline,
    ProjectPrompt,
    Task,
    TaskEvent,
    TaskRun,
    TaskTurn,
)
from ..schemas import (
    ConversationDetail,
    ConversationMessageItem,
    ConversationSummary,
    GlobalPromptItem,
    PendingInteractionType,
    ProjectPipelineItem,
    ProjectPromptItem,
    ProjectSummary,
    SessionRun,
    SessionTurn,
    TaskApprovalResponse,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskSummary,
)
from .events import canonicalize_legacy_event_type
from .tasks import session_id_for_task

def serialize_project(project: Project) -> ProjectSummary:
    return ProjectSummary.model_validate(project, from_attributes=True)


def serialize_project_prompt(prompt: ProjectPrompt) -> ProjectPromptItem:
    return ProjectPromptItem.model_validate(prompt, from_attributes=True)


def serialize_global_prompt(prompt: GlobalPrompt) -> GlobalPromptItem:
    return GlobalPromptItem.model_validate(prompt, from_attributes=True)


def serialize_project_pipeline(pipeline: ProjectPipeline) -> ProjectPipelineItem:
    return ProjectPipelineItem(
        id=pipeline.id,
        project_id=pipeline.project_id,
        name=pipeline.name,
        prompt_ids=json.loads(pipeline.prompt_ids_json or "[]"),
        created_at=pipeline.created_at,
        updated_at=pipeline.updated_at,
    )


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


def serialize_conversation_message(msg: ConversationMessage) -> ConversationMessageItem:
    return ConversationMessageItem(
        id=msg.id,
        conversation_id=msg.conversation_id,
        role=msg.role,
        content=msg.content,
        created_at=msg.created_at,
    )


def serialize_conversation_summary(conv: Conversation) -> ConversationSummary:
    last_msg = conv.messages[-1] if conv.messages else None
    task_status = conv.task.status if conv.task else None
    # Unread means "the newest thing in this conversation is something the
    # agent said, and I haven't opened it since" -- a user's own message
    # never counts (they obviously already saw what they just typed), and
    # opening the conversation (mark_conversation_read) always clears it
    # even if last_read_at wobbles by a few ms against created_at.
    is_unread = bool(
        last_msg is not None
        and last_msg.role == "assistant"
        and (conv.last_read_at is None or last_msg.created_at > conv.last_read_at)
    )
    return ConversationSummary(
        id=conv.id,
        title=conv.title,
        last_message=last_msg.content if last_msg else None,
        project_id=conv.project_id,
        project_name=conv.project.name if conv.project else None,
        task_id=conv.task_id,
        task_status=task_status,  # type: ignore[arg-type]
        updated_at=conv.updated_at,
        is_unread=is_unread,
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
        task_pipeline_id=task.pipeline_id if task else None,
        task_pipeline_name=task.pipeline_name if task else None,
        task_pipeline_step_index=task.pipeline_step_index if task else None,
        task_pipeline_total_steps=task.pipeline_total_steps if task else None,
        messages=[serialize_conversation_message(msg) for msg in conv.messages],
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )
