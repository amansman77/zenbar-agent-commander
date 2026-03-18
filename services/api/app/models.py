from __future__ import annotations

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


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"))
    title: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="queued")
    execution_mode: Mapped[str] = mapped_column(String(32), default="execute")
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    effective_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

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
