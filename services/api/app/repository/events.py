"""The task event log.

append_event is the single write path for everything a runtime reports: it
normalizes the event type, moves the task's status when the event implies one
(see map_status_from_event), keeps the task's latest diff current, and mirrors
assistant messages into the conversation so the chat view shows them.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..models import Conversation, ConversationMessage, Task, TaskApproval, TaskEvent
from ..schemas import RuntimeEvent, TaskDiff
from .tasks import get_task, update_latest_run_status

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


def canonicalize_legacy_event_type(event_type: str) -> str:
    if event_type == "waiting_approval":
        return "result_approval_requested"
    if event_type == "approved":
        return "result_approval_granted"
    return normalize_event_type(event_type)


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


def list_events(db: Session, task_id: str, exclude_types: set[str] | None = None) -> list[TaskEvent]:
    stmt = select(TaskEvent).where(TaskEvent.task_id == task_id)
    if exclude_types:
        stmt = stmt.where(TaskEvent.type.notin_(exclude_types))
    stmt = stmt.order_by(TaskEvent.seq.asc())
    return list(db.scalars(stmt))


def latest_event_at(db: Session, task_id: str):
    # task.updated_at is NOT a reliable proxy for this: SQLAlchemy only
    # emits an UPDATE (and bumps onupdate=utcnow) when a tracked attribute
    # actually changes, and most command_executed/agent_status events don't
    # touch any Task column -- confirmed live, a real task's updated_at sat
    # 34 minutes stale behind its actual last event. Needed so the "last
    # activity" timestamp stays accurate even when the lean events fetch
    # (list_events with exclude_types) omits the type of event that was
    # actually most recent.
    stmt = select(TaskEvent.created_at).where(TaskEvent.task_id == task_id).order_by(TaskEvent.seq.desc()).limit(1)
    return db.scalar(stmt)


def count_events(db: Session, task_id: str, types: set[str]) -> int:
    stmt = select(func.count()).select_from(TaskEvent).where(TaskEvent.task_id == task_id, TaskEvent.type.in_(types))
    return db.scalar(stmt) or 0


def add_approval(db: Session, task: Task, action: str, actor: str) -> TaskApproval:
    approval = TaskApproval(task_id=task.id, action=action, actor=actor)
    db.add(approval)
    if action == "stop":
        task.status = "stopped"
    db.add(task)
    db.commit()
    db.refresh(approval)
    return approval
