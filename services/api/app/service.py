from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Project, Task
from .repository import (
    append_event,
    clear_runtime_session,
    get_task,
    replace_diff,
    list_events,
    serialize_diff,
    serialize_event,
    serialize_task_detail,
    set_task_workspace,
    set_task_status,
)
from .runtime import RuntimeAdapter
from .schemas import RespondTaskRequest, RuntimeEvent, RuntimeStartRequest
from .streaming import broker
from .workspace import prepare_workspace


class TaskOrchestrator:
    def __init__(self, adapter: RuntimeAdapter) -> None:
        self.adapter = adapter
        self._background_tasks: set[asyncio.Task[None]] = set()

    async def start_task(self, db: Session, task: Task, project: Project) -> Task:
        set_task_status(db, task, "starting")
        if task.execution_mode == "plan":
            append_event(db, task, RuntimeEvent(type="agent_status", message="Checking Codex runtime plan capability"))
            supported_modes = await self.adapter.list_collaboration_modes()
            if supported_modes is None:
                append_event(
                    db,
                    task,
                    RuntimeEvent(type="agent_status", message="Codex runtime does not expose collaborationMode/list; attempting direct plan mode start"),
                )
            elif "plan" not in supported_modes:
                append_event(
                    db,
                    task,
                    RuntimeEvent(
                        type="failed",
                        message="Plan mode is not supported by this Codex App Server",
                        payload={"modes": supported_modes},
                    ),
                )
                raise RuntimeError("Plan mode is not supported by this Codex App Server")
            else:
                append_event(db, task, RuntimeEvent(type="agent_status", message="Codex runtime supports plan mode"))
        prepared = await asyncio.to_thread(
            prepare_workspace,
            project.repo_path,
            project.default_branch,
            task.workspace_type,
            task.workspace_ref,
        )
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        resolved_model, was_defaulted = self._resolve_task_model(db, refreshed)
        resolved_reasoning_effort = self._resolve_reasoning_effort(db, refreshed)
        if was_defaulted:
            refreshed = set_task_status(db, refreshed, "starting")
        refreshed = set_task_workspace(db, refreshed, prepared.workspace_path)
        request = RuntimeStartRequest(
            task_id=refreshed.id,
            title=refreshed.title,
            prompt=refreshed.prompt,
            model=resolved_model,
            reasoning_effort=resolved_reasoning_effort,  # type: ignore[arg-type]
            repo_path=project.repo_path,
            working_directory=prepared.workspace_path,
            default_branch=project.default_branch,
            execution_mode=refreshed.execution_mode,  # type: ignore[arg-type]
            workspace_type=refreshed.workspace_type,  # type: ignore[arg-type]
            workspace_ref=refreshed.workspace_ref,
        )
        session = await self.adapter.start_task(request)
        refreshed = get_task(db, refreshed.id)
        assert refreshed is not None
        refreshed = set_task_status(
            db,
            refreshed,
            "running",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or resolved_model,
        )
        if self.adapter.stream_in_background:
            runner = asyncio.create_task(self._consume_events(task.id, session.session_id))
            self._background_tasks.add(runner)
            runner.add_done_callback(self._background_tasks.discard)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def approve_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        try:
            await self.adapter.approve_task(task.runtime_session_id)
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
                raise
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="failed",
                    message="Codex App Server session is no longer available. Retry the task to continue.",
                    payload={"reason": "stale_runtime_session"},
                ),
            )
            refreshed = get_task(db, task.id)
            assert refreshed is not None
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return refreshed

    async def respond_task(self, db: Session, task: Task, payload: RespondTaskRequest) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        if task.pending_interaction_type != "user_input" or not task.pending_request_id:
            raise RuntimeError("Task is not waiting for user input")
        try:
            await self.adapter.respond_task(task.runtime_session_id, task.pending_request_id, payload.answers)
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
                raise
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="failed",
                    message="Codex App Server session is no longer available. Retry the task to continue.",
                    payload={"reason": "stale_runtime_session"},
                ),
            )
            refreshed = get_task(db, task.id)
            assert refreshed is not None
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return refreshed

    async def stop_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        await self.adapter.stop_task(task.runtime_session_id)
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return refreshed

    async def retry_task(self, db: Session, task: Task, model_override: str | None = None) -> Task:
        if model_override and model_override != task.model:
            task.model = model_override
            db.add(task)
            db.commit()
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="agent_status",
                    message=f"Retry requested with model override: {model_override}",
                    payload={"type": "retry_model_override", "model": model_override},
                ),
            )
            refreshed = get_task(db, task.id)
            assert refreshed is not None
            if refreshed.runtime_session_id:
                refreshed = clear_runtime_session(db, refreshed, status=refreshed.status)
            return await self._restart_with_fresh_session(db, refreshed)
        if not task.runtime_session_id:
            return await self._restart_with_fresh_session(db, task)
        try:
            session = await self.adapter.retry_task(task.runtime_session_id)
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
                raise
            refreshed = get_task(db, task.id)
            assert refreshed is not None
            refreshed = clear_runtime_session(db, refreshed)
            return await self._restart_with_fresh_session(db, refreshed)
        db.expire_all()
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        refreshed = set_task_status(
            db,
            refreshed,
            "starting",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or refreshed.model,
        )
        if self.adapter.stream_in_background:
            runner = asyncio.create_task(self._consume_events(task.id, session.session_id))
            self._background_tasks.add(runner)
            runner.add_done_callback(self._background_tasks.discard)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def refresh_diff(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            return task
        try:
            diff = await self.adapter.get_diff(task.runtime_session_id)
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
                raise
            return task
        updated = replace_diff(db, task, diff)
        db.expire_all()
        assert updated is not None
        return updated

    async def _restart_with_fresh_session(self, db: Session, task: Task) -> Task:
        project = task.project
        if project is None:
            raise RuntimeError("Task project is missing")
        append_event(
            db,
            task,
            RuntimeEvent(
                type="agent_status",
                message="Starting a fresh Codex App Server session for retry",
                payload={"reason": "fresh_retry_session"},
            ),
        )
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return await self.start_task(db, refreshed, project)

    def _resolve_task_model(self, db: Session, task: Task) -> tuple[str, bool]:
        if task.model:
            return task.model, False
        default_model = os.getenv("ZENBAR_LEGACY_DEFAULT_MODEL", "default").strip() or "default"
        task.model = default_model
        db.add(task)
        db.commit()
        append_event(
            db,
            task,
            RuntimeEvent(
                type="agent_status",
                message="Model defaulted for legacy task retry",
                payload={"type": "model_defaulted", "reason": "legacy_task", "model": default_model},
            ),
        )
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return default_model, True

    def _resolve_reasoning_effort(self, db: Session, task: Task) -> str:
        if task.reasoning_effort in {"low", "medium", "high"}:
            return task.reasoning_effort
        task.reasoning_effort = "medium"
        db.add(task)
        db.commit()
        return "medium"

    async def _consume_events(self, task_id: str, session_id: str) -> None:
        attempts = 0
        while attempts < 3:
            try:
                async for event in self.adapter.subscribe_events(session_id):
                    await self._handle_runtime_event(task_id, event)
                return
            except Exception as exc:
                attempts += 1
                if attempts >= 3:
                    await self._handle_runtime_event(
                        task_id,
                        RuntimeEvent(type="failed", message=f"Runtime stream failed: {exc}", payload={"attempts": attempts}),
                    )
                    return
                await asyncio.sleep(0.5 * attempts)

    async def _handle_runtime_event(self, task_id: str, event: RuntimeEvent) -> None:
        with SessionLocal() as db:
            task = get_task(db, task_id)
            if task is None:
                return
            append_event(db, task, event)
            task = get_task(db, task_id)
            assert task is not None
            if task.runtime_session_id and event.type in {"diff_generated", "completed"}:
                task = await self.refresh_diff(db, task)
            records = list_events(db, task_id)
            latest_event = serialize_event(records[-1])
            payload = {
                "event": latest_event.model_dump(mode="json"),
                "task": serialize_task_detail(task).model_dump(mode="json"),
                "diff": serialize_diff(task).model_dump(mode="json"),
            }
        await broker.publish(task_id, payload)


async def stream_task_events(task_id: str) -> AsyncIterator[str]:
    async for payload in broker.subscribe(task_id):
        yield payload
