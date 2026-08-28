"""Conversations and their messages -- the chat surface around a task."""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from ..models import Conversation, ConversationMessage, Task, utcnow
from ..schemas import AddConversationMessageRequest, CreateConversationRequest


def create_conversation(db: Session, payload: CreateConversationRequest) -> Conversation:
    conv = Conversation(title=payload.title, project_id=payload.project_id)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


_ACTIVE_TASK_STATUSES = {"queued", "starting", "running", "waiting_user_input", "waiting_result_approval"}


def list_conversations(db: Session, preview_count: int | None = None) -> list[Conversation]:
    stmt = (
        select(Conversation)
        .options(
            selectinload(Conversation.project),
            selectinload(Conversation.messages),
            selectinload(Conversation.task),
        )
        .order_by(Conversation.updated_at.desc())
    )
    conversations = list(db.scalars(stmt))
    if preview_count is None:
        return conversations
    # Per-project preview: the first `preview_count` conversations for each
    # project (already in updated_at-desc order, so this is "most recently
    # active"), PLUS any conversation with a still-running task regardless
    # of its position -- without that carve-out, a conversation whose task
    # completes while sitting past the preview cutoff would never surface
    # a completion notification, since the poller watching for status
    # transitions (useTaskCompletionNotifications) would simply never see
    # it. Measured live: this cuts a 32-conversation/35KB response down to
    # the ~7 conversations actually visible by default (~78% smaller).
    seen_per_project: dict[str | None, int] = {}
    preview: list[Conversation] = []
    for conv in conversations:
        key = conv.project_id
        seen = seen_per_project.get(key, 0)
        is_active = conv.task is not None and conv.task.status in _ACTIVE_TASK_STATUSES
        if seen < preview_count or is_active:
            preview.append(conv)
        seen_per_project[key] = seen + 1
    return preview


def count_conversations_by_project(db: Session) -> dict[str | None, int]:
    stmt = select(Conversation.project_id, func.count()).group_by(Conversation.project_id)
    return dict(db.execute(stmt).all())


def get_conversation(db: Session, conversation_id: str) -> Conversation | None:
    stmt = (
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .options(
            selectinload(Conversation.messages),
            selectinload(Conversation.project),
            selectinload(Conversation.task).selectinload(Task.project),
        )
        # Same reasoning as get_task's populate_existing: this is called
        # multiple times within one request (e.g. post_conversation_message
        # re-fetches before/after starting or following up a task), and
        # without it, an already-loaded `.task` relationship (e.g. still
        # None from before the task existed) wouldn't be refreshed by a
        # later call in the same Session.
        .execution_options(populate_existing=True)
    )
    return db.scalars(stmt).first()


def get_conversation_for_task(db: Session, task_id: str) -> Conversation | None:
    stmt = select(Conversation).where(Conversation.task_id == task_id).options(selectinload(Conversation.messages))
    return db.scalars(stmt).first()


def delete_conversation(db: Session, conversation_id: str) -> None:
    conv = db.get(Conversation, conversation_id)
    if conv:
        db.delete(conv)
        db.commit()


def mark_conversation_read(db: Session, conversation_id: str) -> None:
    # utcnow() (Python-side, microsecond precision), not
    # func.current_timestamp() (SQLite-side, truncated to whole seconds) --
    # ConversationMessage.created_at uses the former, so comparing the two
    # for is_unread (serializers.serialize_conversation_summary) with
    # mismatched precision made a message that arrived earlier in the same
    # second as this write look newer than this read, leaving is_unread
    # stuck True right after marking read. Reproduced live by a test.
    db.execute(update(Conversation).where(Conversation.id == conversation_id).values(last_read_at=utcnow()))
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


def add_conversation_message_for_task(db: Session, task_id: str, role: str, content: str) -> ConversationMessage | None:
    # A pipeline's later steps are sent via TaskOrchestrator.followup_task
    # directly (not through the POST /conversations/{id}/messages endpoint,
    # since nothing external triggers them), which only records a TaskTurn
    # + TaskEvent -- neither of those is a ConversationMessage, so without
    # this each step's prompt after the first would silently never show up
    # in the chat view. Mirrors append_event's own conv lookup for assistant
    # messages (source == "agent_message").
    conv = db.scalars(select(Conversation).where(Conversation.task_id == task_id)).first()
    if conv is None:
        return None
    msg = ConversationMessage(conversation_id=conv.id, role=role, content=content)
    db.add(msg)
    db.execute(
        update(Conversation).where(Conversation.id == conv.id).values(updated_at=func.current_timestamp())
    )
    db.commit()
    db.refresh(msg)
    return msg
