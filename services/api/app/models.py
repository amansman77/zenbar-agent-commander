"""SQLAlchemy ORM models: the persisted shape of the control plane.

Project -> Task -> (TaskRun, TaskTurn, TaskEvent, TaskApproval), plus the
Conversation/ConversationMessage chat surface and a project's saved prompts and
pipelines. Read/write access goes through the repository package, not
these directly.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(255))
    repo_path: Mapped[str] = mapped_column(String(1024))
    default_branch: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)

    tasks: Mapped[list["Task"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    prompts: Mapped[list["ProjectPrompt"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    pipelines: Mapped[list["ProjectPipeline"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectPrompt(Base):
    __tablename__ = "project_prompts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    title: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="prompts")


class ProjectPipeline(Base):
    __tablename__ = "project_pipelines"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(255))
    # Ordered list of ProjectPrompt.id, JSON-encoded. Resolved to each
    # prompt's *current* content at run time (see main.py's conversation
    # message handler), so editing a saved prompt's text later is picked up
    # by pipelines that reference it -- this column is just the recipe
    # (which prompts, in what order), not a content snapshot.
    prompt_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="pipelines")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    title: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="queued")
    execution_mode: Mapped[str] = mapped_column(String(32), default="execute")
    engine: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    effective_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    profile: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reasoning_effort: Mapped[str | None] = mapped_column(String(16), nullable=True)
    workspace_type: Mapped[str] = mapped_column(String(32), default="branch")
    workspace_ref: Mapped[str] = mapped_column(String(255))
    workspace_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    runtime_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pending_interaction_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pending_request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pending_request_payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    latest_diff_summary: Mapped[str] = mapped_column(Text, default="")
    latest_diff_raw: Mapped[str | None] = mapped_column(Text, nullable=True)
    latest_diff_files_json: Mapped[str] = mapped_column(Text, default="[]")
    # Pipeline execution state. pipeline_name/pipeline_steps_json are
    # snapshotted from the ProjectPipeline at the moment this task started
    # running it (not live-resolved), so a pipeline being edited or deleted
    # mid-run can't change what's actually executing. pipeline_steps_json is
    # a JSON list of {"prompt_id", "title", "content"}, in order;
    # pipeline_step_index is the 0-based index of the step this task is
    # currently on (or just finished). All null for non-pipeline tasks.
    pipeline_id: Mapped[str | None] = mapped_column(String, nullable=True)
    pipeline_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pipeline_steps_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    pipeline_step_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    @property
    def pipeline_total_steps(self) -> int | None:
        if not self.pipeline_steps_json:
            return None
        try:
            return len(json.loads(self.pipeline_steps_json))
        except (TypeError, ValueError):
            return None

    project: Mapped[Project] = relationship(back_populates="tasks")
    events: Mapped[list["TaskEvent"]] = relationship(back_populates="task", cascade="all, delete-orphan")
    approvals: Mapped[list["TaskApproval"]] = relationship(back_populates="task", cascade="all, delete-orphan")
    turns: Mapped[list["TaskTurn"]] = relationship(back_populates="task", cascade="all, delete-orphan")
    runs: Mapped[list["TaskRun"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class TaskEvent(Base):
    __tablename__ = "task_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"))
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(64))
    message: Mapped[str] = mapped_column(Text)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    task: Mapped[Task] = relationship(back_populates="events")


class TaskApproval(Base):
    __tablename__ = "task_approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"))
    action: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    task: Mapped[Task] = relationship(back_populates="approvals")


class TaskTurn(Base):
    __tablename__ = "task_turns"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(String(255), index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"))
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    task: Mapped[Task] = relationship(back_populates="turns")


class TaskRun(Base):
    __tablename__ = "task_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(String(255), index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"))
    parent_run_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="running")
    input: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    task: Mapped[Task] = relationship(back_populates="runs")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255), default="New Conversation")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    # Set to "now" whenever the user opens this conversation (see
    # repository.mark_conversation_read) -- compared against the latest
    # assistant message's created_at to derive is_unread. Null means "never
    # opened", i.e. unread as soon as any assistant message exists.
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped["Project | None"] = relationship(foreign_keys="[Conversation.project_id]")
    task: Mapped["Task | None"] = relationship(foreign_keys="[Conversation.task_id]")
    messages: Mapped[list["ConversationMessage"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="ConversationMessage.created_at",
    )


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"))
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
