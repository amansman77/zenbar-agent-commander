"""Metadata and conversation-scoped lookups for uploaded attachments."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import ConversationAttachment


def create_attachment(
    db: Session, *, attachment_id: str, conversation_id: str, name: str, size: int, path: str, maximum_bytes: int
) -> ConversationAttachment:
    attachment = ConversationAttachment(id=attachment_id, conversation_id=conversation_id, name=name, size=size, path=path)
    db.add(attachment)
    db.flush()
    if conversation_attachment_bytes(db, conversation_id) > maximum_bytes:
        db.rollback()
        raise ValueError("대화당 첨부파일은 100MB까지 가능합니다.")
    db.commit()
    db.refresh(attachment)
    return attachment


def delete_attachment(db: Session, attachment: ConversationAttachment) -> None:
    db.delete(attachment)
    db.commit()


def get_attachment(db: Session, conversation_id: str, attachment_id: str) -> ConversationAttachment | None:
    return db.scalars(
        select(ConversationAttachment).where(
            ConversationAttachment.id == attachment_id,
            ConversationAttachment.conversation_id == conversation_id,
        )
    ).first()


def conversation_attachment_bytes(db: Session, conversation_id: str) -> int:
    return db.scalar(
        select(func.coalesce(func.sum(ConversationAttachment.size), 0)).where(
            ConversationAttachment.conversation_id == conversation_id
        )
    ) or 0
