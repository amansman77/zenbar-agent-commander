from __future__ import annotations

import os
from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


DATABASE_URL = os.getenv("ZENBAR_DATABASE_URL", "sqlite:///./zenbar.db")


class Base(DeclarativeBase):
    pass


connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def ensure_schema() -> None:
    if not DATABASE_URL.startswith("sqlite"):
        return
    with engine.begin() as connection:
        conv_columns = {row[1] for row in connection.execute(text("PRAGMA table_info(conversations)"))}
        if "project_id" not in conv_columns and conv_columns:
            connection.execute(text("ALTER TABLE conversations ADD COLUMN project_id VARCHAR NULL REFERENCES projects(id)"))
        if "task_id" not in conv_columns and conv_columns:
            connection.execute(text("ALTER TABLE conversations ADD COLUMN task_id VARCHAR NULL REFERENCES tasks(id)"))
        columns = {row[1] for row in connection.execute(text("PRAGMA table_info(tasks)"))}
        project_columns = {row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))}
        statuses = [row[0] for row in connection.execute(text("SELECT DISTINCT status FROM tasks"))]
        event_types = [row[0] for row in connection.execute(text("SELECT DISTINCT type FROM task_events"))]
        if "deleted_at" not in project_columns:
            connection.execute(text("ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMP NULL"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at)"))
        if "execution_mode" not in columns:
            connection.execute(
                text("ALTER TABLE tasks ADD COLUMN execution_mode VARCHAR(32) NOT NULL DEFAULT 'execute'")
            )
        if "model" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN model VARCHAR(255)"))
        if "effective_model" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN effective_model VARCHAR(255)"))
        if "profile" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN profile VARCHAR(255)"))
        if "engine" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN engine VARCHAR(32)"))
        if "reasoning_effort" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN reasoning_effort VARCHAR(16)"))
        if "pending_interaction_type" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pending_interaction_type VARCHAR(64)"))
        if "pending_request_id" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pending_request_id VARCHAR(255)"))
        if "pending_request_payload_json" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pending_request_payload_json TEXT"))
        if "pipeline_id" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pipeline_id VARCHAR"))
        if "pipeline_name" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pipeline_name VARCHAR(255)"))
        if "pipeline_steps_json" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pipeline_steps_json TEXT"))
        if "pipeline_step_index" not in columns:
            connection.execute(text("ALTER TABLE tasks ADD COLUMN pipeline_step_index INTEGER"))
        if "waiting_approval" in statuses:
            connection.execute(
                text("UPDATE tasks SET status = 'waiting_result_approval' WHERE status = 'waiting_approval'")
            )
        if "approved" in statuses:
            connection.execute(text("UPDATE tasks SET status = 'running' WHERE status = 'approved'"))
        if "waiting_approval" in event_types:
            connection.execute(
                text("UPDATE task_events SET type = 'result_approval_requested' WHERE type = 'waiting_approval'")
            )
        if "approved" in event_types:
            connection.execute(
                text("UPDATE task_events SET type = 'result_approval_granted' WHERE type = 'approved'")
            )


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
