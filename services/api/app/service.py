from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Project, Task
from .repository import (
    append_event,
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
from .schemas import RuntimeEvent, RuntimeStartRequest
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
        refreshed = set_task_workspace(db, refreshed, prepared.workspace_path)
        request = RuntimeStartRequest(
            task_id=refreshed.id,
            title=refreshed.title,
            prompt=refreshed.prompt,
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
        refreshed = set_task_status(db, refreshed, "running", runtime_session_id=session.session_id)
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
        await self.adapter.approve_task(task.runtime_session_id)
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return refreshed

    async def stop_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        await self.adapter.stop_task(task.runtime_session_id)
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        return refreshed

    async def retry_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        session = await self.adapter.retry_task(task.runtime_session_id)
        refreshed = get_task(db, task.id)
        assert refreshed is not None
        refreshed = set_task_status(db, refreshed, "starting", runtime_session_id=session.session_id)
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
        diff = await self.adapter.get_diff(task.runtime_session_id)
        updated = replace_diff(db, task, diff)
        assert updated is not None
        return updated

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
            if task.runtime_session_id and event.type in {"diff_generated", "waiting_approval", "completed"}:
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
