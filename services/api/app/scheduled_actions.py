"""Lifespan worker for one-time follow-ups confirmed in a conversation."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from .db import SessionLocal
from .repository import (
    claim_scheduled_action,
    fail_scheduled_action,
    get_conversation,
    get_project,
    get_task,
    list_due_scheduled_actions,
    list_running_scheduled_sessions,
    recover_interrupted_scheduled_actions,
    set_task_status,
)
from .service import TaskOrchestrator

logger = logging.getLogger(__name__)


async def run_due_scheduled_actions(orchestrator: TaskOrchestrator) -> None:
    with SessionLocal() as db:
        due = list_due_scheduled_actions(db)
    for action in due:
        with SessionLocal() as db:
            conv = get_conversation(db, action.conversation_id)
            if conv is None:
                continue
            task = get_task(db, conv.task_id) if conv.task_id else None
            project = get_project(db, conv.project_id) if conv.project_id else None
            if task and orchestrator.is_launching_followup(task.id):
                continue
            task_id = task.id if task and project else None
            prompt = (
                "예약된 작업 실행 요청\n\n"
                f"{action.content}\n\n"
                "지금 위 요청을 수행하고, 확인한 결과와 진행을 막은 사항을 이 대화에 알려줘."
            )
            if not claim_scheduled_action(db, action, task_id, prompt):
                continue
            if task is None or project is None:
                fail_scheduled_action(db, action, "대화에 연결된 작업이나 프로젝트가 없어 예약 작업을 실행할 수 없습니다.")
                continue
            try:
                await orchestrator.followup_or_restart_task(db, task, project, prompt)
            except Exception:
                logger.exception("Failed to start scheduled action %s", action.id)
                db.rollback()
                fail_scheduled_action(
                    db, action,
                    "예약 작업의 실행을 확인하지 못했습니다. 실행 기록을 확인한 뒤 필요하면 다시 예약해 주세요.",
                )
                refreshed = get_task(db, task.id)
                if refreshed and refreshed.status == "starting" and not refreshed.runtime_session_id:
                    set_task_status(db, refreshed, "failed")


async def _poll(orchestrator: TaskOrchestrator) -> None:
    while True:
        try:
            await run_due_scheduled_actions(orchestrator)
        except Exception:
            logger.exception("Failed to check due scheduled actions")
        await asyncio.sleep(5)


@asynccontextmanager
async def scheduled_action_worker(orchestrator: TaskOrchestrator):
    with SessionLocal() as db:
        recover_interrupted_scheduled_actions(db)
        active_sessions = list_running_scheduled_sessions(db)
    for task_id, session_id in active_sessions:
        orchestrator.ensure_runtime_stream(task_id, session_id)
    worker = asyncio.create_task(_poll(orchestrator))
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker
