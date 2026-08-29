"""Helpers shared by more than one router: 404s, task state-transition guards,
runtime-error sanitizing, and runtime stream (re)attachment.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..runtime_registry import orchestrator

logger = logging.getLogger(__name__)


def safe_runtime_error_detail(prefix: str, exc: Exception) -> str:
    # Every one of retry/commit/push/approve's exception handlers funnels
    # through here, and the real exception was previously discarded the
    # instant it didn't match one of the allowed fragments below -- a retry
    # failing for any reason other than those five strings showed up to the
    # client (and in this server's own log) as nothing but the generic
    # prefix, with zero trace of what actually went wrong. Hit repeatedly
    # this same day trying to diagnose a run of "Retry failed" 409s with no
    # way to see why.
    logger.exception(prefix)
    detail = str(exc).strip()
    allowed_fragments = (
        "Retry the task to continue.",
        "No changes to commit in Task Workspace",
        "Task has no runtime session",
        "Task workspace is not ready",
        "Task is not waiting for user input",
    )
    if any(fragment in detail for fragment in allowed_fragments):
        return detail
    return prefix


def require_task(task, detail: str = "Task not found"):
    if task is None:
        raise HTTPException(status_code=404, detail=detail)
    return task


def ensure_task_runtime_stream(task) -> None:
    session_id = getattr(task, "runtime_session_id", None)
    orchestrator.ensure_runtime_stream(task.id, session_id)


async def reconcile_and_ensure_task_runtime_stream(task, db: Session):
    task = await orchestrator.reconcile_task_runtime_session(db, task)
    ensure_task_runtime_stream(task)
    return task


def assert_actionable(task):
    if task.runtime_session_id is None:
        raise HTTPException(status_code=409, detail="Task runtime session is missing")


def assert_transition(allowed: bool, detail: str):
    if not allowed:
        raise HTTPException(status_code=409, detail=detail)
