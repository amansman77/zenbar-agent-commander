"""Persistent one-time follow-ups and the messages that accompany their outcomes."""

from __future__ import annotations

from datetime import timezone

from sqlalchemy import delete, exists, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..models import Conversation, ConversationMessage, Project, ScheduledAction, Task, utcnow
from ..schemas import CreateScheduledActionRequest

FOLLOWUP_READY_STATUSES = {"completed", "failed", "stopped"}


def create_scheduled_action(db: Session, conversation_id: str, payload: CreateScheduledActionRequest) -> None:
    run_at = payload.run_at.astimezone(timezone.utc)
    db.add(ScheduledAction(conversation_id=conversation_id, content=payload.content, run_at=run_at))
    try:
        db.commit()
    except IntegrityError:
        # A client retry after a lost response must not schedule a second turn.
        db.rollback()
        already_exists = db.scalar(select(exists().where(
            ScheduledAction.conversation_id == conversation_id,
            ScheduledAction.content == payload.content,
            ScheduledAction.run_at == run_at,
        )))
        if not already_exists:
            raise


def cancel_scheduled_action(db: Session, conversation_id: str, action_id: str) -> bool:
    # Only the pending state can be cancelled. This races safely with a claim.
    cancelled = db.execute(
        delete(ScheduledAction).where(
            ScheduledAction.id == action_id,
            ScheduledAction.conversation_id == conversation_id,
            ScheduledAction.status == "pending",
        )
    ).rowcount == 1
    db.commit()
    return cancelled


def list_due_scheduled_actions(db: Session) -> list[ScheduledAction]:
    running = aliased(ScheduledAction)
    return list(db.scalars(
        select(ScheduledAction)
        .join(Conversation, Conversation.id == ScheduledAction.conversation_id)
        .outerjoin(Task, Task.id == Conversation.task_id)
        .outerjoin(Project, Project.id == Conversation.project_id)
        .where(
            ScheduledAction.status == "pending",
            ScheduledAction.run_at <= utcnow(),
            or_(Task.status.in_(FOLLOWUP_READY_STATUSES), Task.id.is_(None),
                Project.id.is_(None), Project.deleted_at.is_not(None)),
            ~exists().where(running.task_id == Task.id, running.status == "running"),
        )
        .order_by(ScheduledAction.run_at, ScheduledAction.id)
        .limit(50)
    ))


def claim_scheduled_action(db: Session, action: ScheduledAction, task_id: str | None, prompt: str) -> bool:
    # The visible request and claim share a transaction. Once committed, a
    # process restart must never replay this action: an external write may
    # already have happened even if the runtime never acknowledged the turn.
    running = aliased(ScheduledAction)
    available = ~exists().where(running.task_id == task_id, running.status == "running") if task_id else True
    ready = exists().where(Task.id == task_id, Task.status.in_(FOLLOWUP_READY_STATUSES)) if task_id else True
    claimed = db.execute(
        update(ScheduledAction)
        .where(ScheduledAction.id == action.id, ScheduledAction.status == "pending", available, ready)
        .values(status="running", task_id=task_id)
    ).rowcount == 1
    if claimed:
        db.add(ConversationMessage(conversation_id=action.conversation_id, role="user", content=prompt))
        db.execute(update(Conversation).where(Conversation.id == action.conversation_id).values(updated_at=utcnow()))
    db.commit()
    return claimed


def _finish_action(db: Session, action: ScheduledAction, status: str, message: str | None = None) -> None:
    notified_at = utcnow()
    updated = db.execute(
        update(ScheduledAction).where(ScheduledAction.id == action.id, ScheduledAction.status == "running")
        .values(status=status, notified_at=notified_at)
    ).rowcount == 1
    if not updated:
        return
    if message:
        db.add(ConversationMessage(
            conversation_id=action.conversation_id, role="assistant", content=message, created_at=notified_at
        ))
    db.execute(update(Conversation).where(Conversation.id == action.conversation_id).values(updated_at=notified_at))


def fail_scheduled_action(db: Session, action: ScheduledAction, message: str) -> None:
    _finish_action(db, action, "failed", message)
    db.commit()


def record_scheduled_task_status(db: Session, task_id: str, status: str) -> None:
    needs_user = status in {"waiting_user_input", "waiting_result_approval"}
    if status not in FOLLOWUP_READY_STATUSES and not needs_user:
        return
    action = db.scalar(
        select(ScheduledAction).where(ScheduledAction.task_id == task_id, ScheduledAction.status == "running")
    )
    if action is None:
        return
    if needs_user:
        action.notified_at = utcnow()
        return
    message = {
        "failed": "예약 작업이 실패했습니다. 작업 상세에서 원인을 확인할 수 있습니다.",
        "stopped": "예약 작업이 중지되었습니다.",
    }.get(status)
    _finish_action(db, action, status, message)


def has_running_scheduled_action(db: Session, task_id: str) -> bool:
    return bool(db.scalar(select(exists().where(
        ScheduledAction.task_id == task_id, ScheduledAction.status == "running"
    ))))


def list_running_scheduled_sessions(db: Session) -> list[tuple[str, str | None]]:
    stmt = (
        select(Task.id, Task.runtime_session_id)
        .join(ScheduledAction, ScheduledAction.task_id == Task.id)
        .where(ScheduledAction.status == "running")
    )
    return [(task_id, session_id) for task_id, session_id in db.execute(stmt)]


def recover_interrupted_scheduled_actions(db: Session) -> None:
    actions = db.scalars(
        select(ScheduledAction)
        .outerjoin(Task, Task.id == ScheduledAction.task_id)
        .where(
            ScheduledAction.status == "running",
            or_(Task.id.is_(None), Task.status.in_(FOLLOWUP_READY_STATUSES)),
        )
    ).all()
    for action in actions:
        _finish_action(
            db, action, "failed",
            "서버 재시작으로 예약 작업이 실행됐는지 확인할 수 없습니다. 재예약하기 전에 결과를 확인해 주세요.",
        )
    db.commit()
