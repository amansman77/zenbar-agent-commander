"""TaskOrchestrator: the task lifecycle, sitting between routers and runtimes.

Starts/stops/approves/retries tasks, prepares and cleans up task workspaces,
consumes each runtime session's event stream in the background, persists the
resulting events and status transitions, advances prompt pipelines, and
reconciles tasks left active across a restart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import AsyncIterator

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Project, Task
from .repository import (
    add_conversation_message_for_task,
    append_event,
    clear_runtime_session,
    create_run,
    create_turn,
    get_latest_run,
    get_task,
    replace_diff,
    list_events,
    serialize_diff,
    serialize_event,
    serialize_task_detail,
    set_task_pipeline_step,
    set_task_workspace,
    set_task_status,
)
from . import workspace_git
from .runtime import RuntimeAdapter
from .schemas import (
    RespondTaskRequest,
    RuntimeEvent,
    RuntimeStartRequest,
    TaskCommitRequest,
    TaskDiff,
    TaskGitActionResponse,
    TaskPushRequest,
)
from .streaming import broker
from .workspace import prepare_workspace

logger = logging.getLogger(__name__)


def _is_stale_session_error(exc: Exception) -> bool:
    # Two different shapes mean the same thing -- "this session doesn't
    # exist anymore, clear it and start fresh" -- but come from different
    # layers. Every adapter's own local _require_session raises
    # "Unknown <X> session" when OUR process has no record of the session
    # at all (e.g. right after an API restart, before Codex's App Server
    # reconnects). Codex specifically can *also* still have a locally-valid
    # session record while the actual remote App Server process has quietly
    # dropped that thread (evicted, or hiccuped without a full crash) --
    # that surfaces as the App Server's own RPC error message, verbatim,
    # which is "thread not found: <id>", not "Unknown ... session". Missing
    # this second shape meant retry_task re-raised instead of self-healing
    # (a real 409 a user hit), and _consume_events' background loop treated
    # it as a transient stream hiccup and reconnected forever instead of
    # ending the loop -- which is why a task already marked "failed" kept
    # producing "still running" heartbeat events indefinitely. Reproduced
    # live via the exception logging added to safe_runtime_error_detail.
    exc_msg = str(exc)
    if exc_msg.startswith("Unknown ") and exc_msg.endswith(" session"):
        return True
    return exc_msg.startswith("thread not found:")


class TaskOrchestrator:
    ACTIVE_TASK_STATUSES = {"starting", "running", "waiting_user_input", "waiting_result_approval"}

    def __init__(self, adapters: dict[str, RuntimeAdapter], default_engine: str = "codex") -> None:
        self.adapters = adapters
        self.default_engine = default_engine
        # Back-compat alias: main.py's model_catalog and several tests reach
        # into `orchestrator.adapter` directly, expecting "the" adapter. Keep
        # it pointed at the default engine's (same object as adapters[...],
        # not a second instance — see create_engine_adapters' docstring).
        self.adapter = adapters[default_engine]
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._stream_tasks: dict[str, asyncio.Task[None]] = {}
        # codex-rs has no watchdog of its own for a backgrounded shell/PTY
        # process (unified_exec) that nobody ever polls again -- confirmed by
        # reading process_manager.rs, 2026-08-31: it only exposes explicit
        # terminate_process()/terminate_all_processes(), no idle reaper. When
        # that happens the session keeps reporting itself alive forever while
        # producing nothing but idle_heartbeat events. Mitigated here instead
        # of in the fork, since it's a narrower, testable, control-plane-side
        # fix rather than surgery on an unfamiliar process manager that also
        # has to keep working for legitimate long-lived background processes.
        self._stuck_session_idle_seconds = float(
            os.getenv("ZENBAR_STUCK_SESSION_IDLE_SECONDS", str(15 * 60))
        )

    def _adapter_for(self, task: Task | None) -> RuntimeAdapter:
        engine = (task.engine if task is not None else None) or self.default_engine
        return self.adapters.get(engine, self.adapter)

    def _adapter_for_task_id(self, task_id: str) -> RuntimeAdapter:
        with SessionLocal() as db:
            task = get_task(db, task_id)
        return self._adapter_for(task)

    def _require_task(self, db: Session, task_id: str, action: str) -> Task:
        refreshed = get_task(db, task_id)
        if refreshed is None:
            raise RuntimeError(f"Task '{task_id}' disappeared while {action}")
        return refreshed

    def ensure_runtime_stream(self, task_id: str, session_id: str | None) -> None:
        if not self._adapter_for_task_id(task_id).stream_in_background:
            return
        if not session_id:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Called from a sync context without an active event loop.
            return
        existing = self._stream_tasks.get(task_id)
        if existing is not None and not existing.done():
            return
        self._start_background_consumer(task_id, session_id, loop=loop)

    def _start_background_consumer(
        self,
        task_id: str,
        session_id: str,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        existing = self._stream_tasks.get(task_id)
        if existing is not None and not existing.done():
            return
        if loop is None:
            loop = asyncio.get_running_loop()
        runner = loop.create_task(self._consume_events(task_id, session_id))
        self._background_tasks.add(runner)
        self._stream_tasks[task_id] = runner

        def _cleanup(completed: asyncio.Task[None]) -> None:
            self._background_tasks.discard(completed)
            current = self._stream_tasks.get(task_id)
            if current is completed:
                self._stream_tasks.pop(task_id, None)

        runner.add_done_callback(_cleanup)

    async def start_task(self, db: Session, task: Task, project: Project, selected_skill: str | None = None) -> Task:
        adapter = self._adapter_for(task)
        parent_run = get_latest_run(db, task.id)
        create_run(db, task, input_text=task.prompt, parent_run_id=parent_run.id if parent_run else None)
        set_task_status(db, task, "starting")
        if task.execution_mode == "plan":
            append_event(db, task, RuntimeEvent(type="agent_status", message="Checking Codex runtime plan capability"))
            supported_modes = await adapter.list_collaboration_modes()
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
        from pathlib import Path
        existing_workspace = task.workspace_path and Path(task.workspace_path).exists()
        if existing_workspace:
            from .workspace import PreparedWorkspace
            prepared = PreparedWorkspace(task.workspace_path, task.workspace_ref, task.workspace_type)
        else:
            prepared = await asyncio.to_thread(
                prepare_workspace,
                project.repo_path,
                project.default_branch,
                task.workspace_type,
                task.workspace_ref,
            )
        refreshed = self._require_task(db, task.id, "preparing workspace")
        resolved_model, was_defaulted = self._resolve_task_model(db, refreshed)
        resolved_reasoning_effort = self._resolve_reasoning_effort(db, refreshed)
        if was_defaulted:
            refreshed = set_task_status(db, refreshed, "starting")
        refreshed = set_task_workspace(db, refreshed, prepared.workspace_path)
        request = RuntimeStartRequest(
            task_id=refreshed.id,
            title=refreshed.title,
            prompt=refreshed.prompt,
            engine=refreshed.engine,
            model=resolved_model,
            profile=refreshed.profile,
            reasoning_effort=resolved_reasoning_effort,  # type: ignore[arg-type]
            repo_path=project.repo_path,
            working_directory=prepared.workspace_path,
            default_branch=project.default_branch,
            execution_mode=refreshed.execution_mode,  # type: ignore[arg-type]
            workspace_type=refreshed.workspace_type,  # type: ignore[arg-type]
            workspace_ref=refreshed.workspace_ref,
            selected_skill=selected_skill,
        )
        session = await adapter.start_task(request)
        refreshed = self._require_task(db, refreshed.id, "starting runtime session")
        refreshed = set_task_status(
            db,
            refreshed,
            "running",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or resolved_model,
        )
        if adapter.stream_in_background:
            self._start_background_consumer(task.id, session.session_id)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def approve_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        adapter = self._adapter_for(task)
        try:
            await adapter.approve_task(task.runtime_session_id)
        except RuntimeError as exc:
            # See _is_stale_session_error's own comment for the two shapes
            # this recognizes.
            if not _is_stale_session_error(exc):
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
            refreshed = self._require_task(db, task.id, "clearing stale runtime session")
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "refreshing approval state")
        return refreshed

    async def respond_task(self, db: Session, task: Task, payload: RespondTaskRequest) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        if task.pending_interaction_type != "user_input" or not task.pending_request_id:
            raise RuntimeError("Task is not waiting for user input")
        adapter = self._adapter_for(task)
        try:
            await adapter.respond_task(task.runtime_session_id, task.pending_request_id, payload.answers)
        except RuntimeError as exc:
            # See _is_stale_session_error's own comment for the two shapes
            # this recognizes.
            if not _is_stale_session_error(exc):
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
            refreshed = self._require_task(db, task.id, "clearing stale runtime session")
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "refreshing response state")
        return refreshed

    async def stop_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        adapter = self._adapter_for(task)
        await adapter.stop_task(task.runtime_session_id)
        if not adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "stopping task")
        return refreshed

    async def retry_task(
        self,
        db: Session,
        task: Task,
        model_override: str | None = None,
        profile_override: str | None = None,
    ) -> Task:
        model_changed = bool(model_override and model_override != task.model)
        profile_changed = profile_override is not None and profile_override != (task.profile or "")
        if model_changed or profile_changed:
            if model_changed:
                task.model = model_override
            if profile_changed:
                task.profile = profile_override or None
            db.add(task)
            db.commit()
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="agent_status",
                    message="Retry requested with " + " and ".join(
                        filter(
                            None,
                            [
                                f"model override: {model_override}" if model_changed else None,
                                f"profile override: {task.profile or 'none'}" if profile_changed else None,
                            ],
                        )
                    ),
                    payload={
                        "type": "retry_override",
                        "model": model_override if model_changed else None,
                        "profile": task.profile if profile_changed else None,
                    },
                ),
            )
            refreshed = self._require_task(db, task.id, "applying retry overrides")
            if refreshed.runtime_session_id:
                refreshed = clear_runtime_session(db, refreshed, status=refreshed.status)
            return await self._restart_with_fresh_session(db, refreshed)
        if not task.runtime_session_id:
            return await self._restart_with_fresh_session(db, task)
        parent_run = get_latest_run(db, task.id)
        create_run(db, task, input_text="Run again", parent_run_id=parent_run.id if parent_run else None)
        adapter = self._adapter_for(task)
        try:
            session = await adapter.retry_task(task.runtime_session_id)
        except RuntimeError as exc:
            # See _is_stale_session_error's own comment for the two shapes
            # this recognizes.
            if not _is_stale_session_error(exc):
                raise
            refreshed = self._require_task(db, task.id, "recovering from stale retry session")
            refreshed = clear_runtime_session(db, refreshed)
            return await self._restart_with_fresh_session(db, refreshed)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "retrying task")
        refreshed = set_task_status(
            db,
            refreshed,
            "starting",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or refreshed.model,
        )
        if adapter.stream_in_background:
            self._start_background_consumer(task.id, session.session_id)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def followup_task(
        self, db: Session, task: Task, content: str, selected_skill: str | None = None, model: str | None = None
    ) -> Task:
        if task.status in {"starting", "running", "waiting_user_input", "waiting_result_approval"}:
            raise RuntimeError(f"Task cannot accept follow-up from status '{task.status}'")
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        create_turn(db, task, role="user", content=content)
        append_event(
            db,
            task,
            RuntimeEvent(
                type="agent_status",
                message=content,
                payload={"role": "user", "content": content},
            ),
        )
        parent_run = get_latest_run(db, task.id)
        create_run(db, task, input_text=content, parent_run_id=parent_run.id if parent_run else None)
        adapter = self._adapter_for(task)
        # model: switch for this and subsequent turns, same session/
        # workspace/history -- None means "keep whatever this task is
        # already using". effective_model below picks up the change
        # automatically since it already always trusts what the adapter
        # reports back.
        session = await adapter.followup_task(task.runtime_session_id, content, selected_skill=selected_skill, model=model)
        refreshed = self._require_task(db, task.id, "starting follow-up turn")
        refreshed = set_task_status(
            db,
            refreshed,
            "running",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or refreshed.model,
        )
        # Unlike start_task/retry_task (which this mirrors), this call was
        # missing the stream_in_background branch entirely -- a follow-up
        # message on a completed/failed/stopped task always mints a brand
        # new session_id, so without spawning a fresh background consumer
        # here, the new turn ran completely unmonitored for a background-
        # streaming adapter (Codex App Server, Claude, Grok, Antigravity):
        # no heartbeats, no completion/failure detection, nothing -- until
        # some unrelated request happened to poll the task and trigger
        # reconcile_and_ensure_task_runtime_stream. Caught live 2026-08-30:
        # two follow-up turns sat "running" with zero events for ~45
        # minutes because nothing was subscribed to their new session.
        if adapter.stream_in_background:
            self._start_background_consumer(task.id, session.session_id)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def refresh_diff(self, db: Session, task: Task) -> Task:
        runtime_diff: TaskDiff | None = None
        if task.runtime_session_id:
            try:
                runtime_diff = await self._adapter_for(task).get_diff(task.runtime_session_id)
            except RuntimeError as exc:
                # See _is_stale_session_error's own comment for the two
                # shapes this recognizes.
                if not _is_stale_session_error(exc):
                    raise

        fallback_diff = await asyncio.to_thread(workspace_git.compute_workspace_diff, task)
        # Workspace git diff is ground truth (staged/unstaged only — empty after commit).
        # If workspace is clean, clear any stale diff in the DB.
        chosen = fallback_diff if fallback_diff is not None else TaskDiff()

        updated = replace_diff(db, task, chosen)
        db.expire_all()
        if updated is None:
            raise RuntimeError(f"Task '{task.id}' disappeared while persisting diff")
        return updated

    async def reconcile_task_runtime_session(self, db: Session, task: Task) -> Task:
        if task.status not in self.ACTIVE_TASK_STATUSES:
            return task
        if not task.runtime_session_id:
            return task
        try:
            await self._adapter_for(task).get_diff(task.runtime_session_id)
            return task
        except RuntimeError as exc:
            # See _is_stale_session_error's own comment for the two shapes
            # this recognizes (Codex App Server, Claude, Grok, Antigravity).
            # Claude/Grok/Antigravity keep session state only in-process
            # (unlike Codex, which reconnects to the still-running App
            # Server), so any active task using one of them hits this on
            # every restart -- and this function runs at startup
            # (reconcile_active_tasks, in the FastAPI lifespan), so before
            # this the app couldn't even start with such a task in the
            # database: the unhandled RuntimeError propagated out of
            # lifespan and crashed the whole process on boot, not just that
            # one task's reconciliation.
            if not _is_stale_session_error(exc):
                raise
        refreshed = self._require_task(db, task.id, "reconciling stale runtime session")
        refreshed = clear_runtime_session(db, refreshed)
        append_event(
            db,
            refreshed,
            RuntimeEvent(
                type="failed",
                message="Runtime session is no longer available. Retry the task to continue.",
                payload={"reason": "stale_runtime_session", "cleanup": "reconcile"},
            ),
        )
        db.expire_all()
        return self._require_task(db, task.id, "refreshing reconciled task")

    async def reconcile_active_tasks(self) -> int:
        with SessionLocal() as db:
            task_ids = list(
                db.scalars(
                    select(Task.id).where(
                        Task.status.in_(self.ACTIVE_TASK_STATUSES),
                        Task.runtime_session_id.is_not(None),
                    )
                )
            )
            reconciled = 0
            for task_id in task_ids:
                task = get_task(db, task_id)
                if task is None:
                    continue
                status_before = task.status
                task = await self.reconcile_task_runtime_session(db, task)
                if status_before != task.status and task.status == "failed":
                    reconciled += 1

            # Tasks in an active status with NO runtime session at all can't
            # be running: an active status is only ever set alongside opening
            # a session, so this means the process died between the two (e.g.
            # a start/retry that raised, or the server being killed mid-start).
            # The query above deliberately requires a session, and
            # reconcile_task_runtime_session early-returns without one, so
            # nothing else can ever heal these -- they'd stay "in progress"
            # forever and refuse follow-ups/retries. Safe to do here because
            # reconcile_active_tasks only runs at startup, when no task in
            # this process can legitimately be mid-start.
            orphan_ids = list(
                db.scalars(
                    select(Task.id).where(
                        Task.status.in_(self.ACTIVE_TASK_STATUSES),
                        Task.runtime_session_id.is_(None),
                    )
                )
            )
            for task_id in orphan_ids:
                task = get_task(db, task_id)
                if task is None:
                    continue
                append_event(
                    db,
                    task,
                    RuntimeEvent(
                        type="failed",
                        message="Task was left without a runtime session (interrupted while starting). Retry to continue.",
                        payload={"reason": "orphaned_active_task_no_session"},
                    ),
                )
                reconciled += 1
            return reconciled

    async def commit_workspace(self, db: Session, task: Task, payload: TaskCommitRequest) -> TaskGitActionResponse:
        if not task.workspace_path:
            raise RuntimeError("Task workspace is not ready")
        result = await asyncio.to_thread(workspace_git.commit_workspace, task.workspace_path, payload.message, payload.actor)
        append_event(
            db,
            task,
            RuntimeEvent(
                type="agent_status",
                message=f"Workspace committed on {result.branch}",
                payload={"type": "workspace_committed", "branch": result.branch, "message": payload.message},
            ),
        )
        return result

    async def push_workspace(self, db: Session, task: Task, payload: TaskPushRequest) -> TaskGitActionResponse:
        if not task.workspace_path:
            raise RuntimeError("Task workspace is not ready")
        result = await asyncio.to_thread(
            workspace_git.push_workspace,
            task.workspace_path,
            payload.remote,
            payload.set_upstream,
        )
        append_event(
            db,
            task,
            RuntimeEvent(
                type="agent_status",
                message=f"Workspace branch pushed: {result.remote}/{result.branch}",
                payload={"type": "workspace_pushed", "branch": result.branch, "remote": result.remote},
            ),
        )
        return result

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
        refreshed = self._require_task(db, task.id, "starting fresh retry session")
        return await self.start_task(db, refreshed, project)

    def _resolve_task_model(self, db: Session, task: Task) -> tuple[str, bool]:
        if task.model:
            # effective_model wins when set -- a mid-session model switch
            # updates only that field (not task.model, the originally
            # *requested* one), so a session-expired restart that goes
            # through this same start_task path must prefer it too, or it
            # would silently revert to whatever model the task started
            # with. Legacy tasks with no task.model at all still fall
            # through to the backfill below unchanged.
            return task.effective_model or task.model, False
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
        refreshed = self._require_task(db, task.id, "defaulting legacy model")
        return default_model, True

    def _resolve_reasoning_effort(self, db: Session, task: Task) -> str:
        if task.reasoning_effort in {"low", "medium", "high"}:
            return task.reasoning_effort
        task.reasoning_effort = "medium"
        db.add(task)
        db.commit()
        return "medium"

    async def _consume_events(self, task_id: str, session_id: str) -> None:
        adapter = self._adapter_for_task_id(task_id)
        if not adapter.stream_in_background:
            async for event in adapter.subscribe_events(session_id):
                await self._handle_runtime_event(task_id, event)
            return

        async def _task_still_active() -> bool:
            with SessionLocal() as db:
                current = get_task(db, task_id)
            return current is not None and current.status in self.ACTIVE_TASK_STATUSES

        attempts = 0
        # See the comment on self._stuck_session_idle_seconds: codex-rs
        # itself never reaps a backgrounded process nobody polls again, so a
        # session can report itself "alive" forever while producing nothing
        # but idle_heartbeat events. A task that's genuinely working -- even
        # on a slow shell command -- keeps producing other event types
        # (command_executed/outputDelta chunks, plan updates, ...) in
        # between heartbeats, which is what makes "only heartbeats for this
        # long" a reliable stuck signal rather than a false positive on a
        # slow-but-live command. Tracked across reconnects (not reset inside
        # the try block below), since a reconnect alone doesn't mean the
        # underlying session became any less stuck.
        last_real_event_at = time.monotonic()
        while True:
            try:
                async for event in adapter.subscribe_events(session_id):
                    is_idle_heartbeat = (
                        event.type == "agent_status" and (event.payload or {}).get("reason") == "idle_heartbeat"
                    )
                    if is_idle_heartbeat:
                        idle_for = time.monotonic() - last_real_event_at
                        if idle_for >= self._stuck_session_idle_seconds:
                            if await self._auto_recover_stuck_session(task_id, idle_for):
                                return
                            # Recovery didn't apply (task no longer active,
                            # or lost its session in the meantime) -- avoid
                            # re-checking on every single heartbeat until it
                            # does.
                            last_real_event_at = time.monotonic()
                    else:
                        last_real_event_at = time.monotonic()
                    await self._handle_runtime_event(task_id, event)
                # A "failed"/"completed"/"stopped" event delivered as a
                # normal item on this same stream (e.g. the notLoaded
                # handler in runtime/app_server.py) already moved
                # task.status to a terminal one via _handle_runtime_event
                # above -- reconnecting after that produced "still running"
                # heartbeats on a task already reported failed, for as long
                # as nobody happened to check (hours, reproduced live).
                # Checked *after* the attempt (not before, unlike the
                # exception branch's stale-session check below) so a loop
                # entered against an already-terminal task -- e.g. cleaning
                # up a leftover session_id after completion -- still gets
                # its one subscribe attempt instead of exiting before ever
                # trying.
                if not await _task_still_active():
                    return
                # Re-subscribe if runtime stream ended unexpectedly while
                # the task is still genuinely active.
                attempts += 1
                await self._handle_runtime_event(
                    task_id,
                    RuntimeEvent(
                        type="agent_status",
                        message="Runtime event stream closed; attempting to reconnect.",
                        payload={"attempts": attempts, "reason": "stream_closed"},
                    ),
                )
            except Exception as exc:
                attempts += 1
                detail = str(exc)
                # See _is_stale_session_error's own comment for the two
                # shapes this recognizes -- missing the second one
                # ("thread not found: ...") here specifically meant a task
                # already reported failed elsewhere kept this loop alive,
                # reconnecting forever and producing "still running"
                # heartbeat events indefinitely instead of actually ending.
                if _is_stale_session_error(exc):
                    await self._handle_stale_runtime_session(task_id, attempts)
                    return
                if not await _task_still_active():
                    return
                await self._handle_runtime_event(
                    task_id,
                    RuntimeEvent(
                        type="agent_status",
                        message="Runtime stream interrupted; reconnecting in background.",
                        payload={"attempts": attempts, "error": detail[:500]},
                    ),
                )
            await asyncio.sleep(min(0.5 * attempts, 5.0))

    async def _auto_recover_stuck_session(self, task_id: str, idle_seconds: float) -> bool:
        """Self-heals a task whose session has gone quiet for too long with
        zero real output -- see self._stuck_session_idle_seconds' comment for
        why this lives here rather than as a fix in codex-rs. Stops the
        wedged session and retries with a fresh one, the same recovery this
        mirrors from being done by hand (2026-08-30: two tasks sat "running"
        for 30-90 minutes on a hung backgrounded process before anyone
        noticed). Returns True if a fresh consumer now owns task_id's stream
        (the caller must stop consuming the old one either way), False if
        recovery didn't apply (task already left the active states, or lost
        its session) -- the caller keeps consuming the current stream then.
        """
        with SessionLocal() as db:
            task = get_task(db, task_id)
            if task is None or task.status not in self.ACTIVE_TASK_STATUSES or not task.runtime_session_id:
                return False
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="agent_status",
                    message=(
                        f"No real output for over {int(idle_seconds // 60)} minute(s) -- "
                        "assuming the runtime session is stuck (likely a backgrounded process "
                        "the App Server spawned that nobody is polling anymore). "
                        "Stopping and retrying automatically."
                    ),
                    payload={"reason": "auto_recovered_stuck_session", "idle_seconds": int(idle_seconds)},
                ),
            )
        # This coroutine is itself the background consumer currently
        # registered under _stream_tasks[task_id]. retry_task (below) will
        # try to register a fresh one under that same key via
        # ensure_runtime_stream/_start_background_consumer, whose "already
        # have one" guard would otherwise see this not-yet-returned task and
        # skip spawning the new one -- so it has to be cleared first.
        self._stream_tasks.pop(task_id, None)

        async def _recover() -> None:
            with SessionLocal() as db:
                task = get_task(db, task_id)
                if task is None:
                    return
                try:
                    await self.stop_task(db, task)
                except Exception:
                    # Matches a known gap: the App Server's interrupt RPC can
                    # itself fail ("no active turn to interrupt") when the
                    # turn is this wedged. Proceed regardless, same as the
                    # manual recovery this mirrors.
                    pass
                task = get_task(db, task_id)
                if task is None:
                    return
                # stop_task doesn't clear runtime_session_id itself (that
                # normally only happens once the App Server pushes its own
                # stopped/failed notification through the event stream) --
                # but that stream is exactly what we just stopped consuming,
                # and the stuck thread may never actually deliver one. Force
                # it explicitly so retry_task below takes the guaranteed-
                # clean _restart_with_fresh_session path (a brand new
                # thread/turn) instead of reusing the same possibly-still-
                # wedged thread_id via adapter.retry_task's plain turn/start.
                if task.runtime_session_id:
                    task = clear_runtime_session(db, task)
                await self.retry_task(db, task)

        try:
            # This is an unsupervised background action -- nobody's around to
            # notice if the very RPCs meant to recover a wedged session hang
            # too. Live evidence from the incident this mirrors says
            # turn/interrupt responds promptly even when the turn itself is
            # stuck, but that's not a guarantee, so bound it rather than risk
            # trading "stuck producing heartbeats" for "stuck silently with
            # no heartbeats at all".
            await asyncio.wait_for(_recover(), timeout=60.0)
            return True
        except Exception:
            logger.exception("Auto-recovery from stuck runtime session failed for task %s", task_id)
            return False

    async def _handle_stale_runtime_session(self, task_id: str, attempts: int) -> None:
        with SessionLocal() as db:
            task = get_task(db, task_id)
            if task is None:
                return
            terminal = task.status in {"completed", "stopped"}
            if task.runtime_session_id:
                task = clear_runtime_session(db, task, status=task.status if terminal else "failed")
            if terminal:
                event = RuntimeEvent(
                    type="agent_status",
                    message="Runtime session ended after task completion.",
                    payload={"attempts": attempts, "reason": "stale_runtime_session_terminal"},
                )
            else:
                event = RuntimeEvent(
                    type="failed",
                    message="Runtime session is no longer available. Retry the task to continue.",
                    payload={"attempts": attempts, "reason": "stale_runtime_session"},
                )
            append_event(db, task, event)
            task = get_task(db, task_id)
            if task is None:
                return
            records = list_events(db, task_id)
            latest_event = serialize_event(records[-1])
            payload = {
                "event": latest_event.model_dump(mode="json"),
                "task": serialize_task_detail(task).model_dump(mode="json"),
                "diff": serialize_diff(task).model_dump(mode="json"),
            }
        await broker.publish(task_id, payload)

    async def _handle_runtime_event(self, task_id: str, event: RuntimeEvent) -> None:
        with SessionLocal() as db:
            task = get_task(db, task_id)
            if task is None:
                return
            append_event(db, task, event)
            task = get_task(db, task_id)
            if task is None:
                return
            if task.runtime_session_id and event.type in {"diff_generated", "completed"}:
                task = await self.refresh_diff(db, task)
            task = await self._advance_pipeline_if_needed(db, task)
            records = list_events(db, task_id)
            latest_event = serialize_event(records[-1])
            payload = {
                "event": latest_event.model_dump(mode="json"),
                "task": serialize_task_detail(task).model_dump(mode="json"),
                "diff": serialize_diff(task).model_dump(mode="json"),
            }
        await broker.publish(task_id, payload)

    async def _advance_pipeline_if_needed(self, db: Session, task: Task) -> Task:
        """Prompt pipelines run fully automatically (no per-step human
        approval, per the chosen design): once a pipeline task's current
        step is done, advance to the next one immediately as a follow-up
        turn in the same session. A step failing (status becomes "failed")
        is simply not handled here, so the pipeline naturally stops -- there
        is no "resume" path, matching "실패하면 파이프라인 중단".

        A step being "done" means either waiting_result_approval (the
        runtime paused mid-turn to ask permission for a specific file edit
        or command -- see item/fileChange/requestApproval in runtime/app_server.py) or
        already completed outright. Both are real, common outcomes: the App
        Server only requests a mid-turn approval when its own approval
        policy decides one particular action needs it, which most turns
        never trigger -- confirmed live against a real Codex pipeline task
        that ran a full turn and reported turn/completed without a single
        approval request anywhere in its ~450 events. The pipeline used to
        only advance on waiting_result_approval, so real tasks that never
        happened to hit that state (the common case) silently stalled after
        step 1, without ever explicitly failing.
        """
        if not task.pipeline_id or task.status not in {"waiting_result_approval", "completed"}:
            return task
        steps = json.loads(task.pipeline_steps_json or "[]")
        current_index = task.pipeline_step_index if task.pipeline_step_index is not None else 0
        next_index = current_index + 1

        if task.status == "waiting_result_approval":
            try:
                task = await self.approve_task(db, task)
            except Exception as exc:
                append_event(
                    db,
                    task,
                    RuntimeEvent(
                        type="failed",
                        message=f"Pipeline '{task.pipeline_name}' stopped: could not auto-approve step {current_index + 1}/{len(steps)}.",
                        payload={"reason": "pipeline_auto_approve_failed", "error": str(exc)[:500]},
                    ),
                )
                return self._require_task(db, task.id, "pipeline auto-approve failure")
            # approve_task's own event cascade can itself route back through
            # this very method for a nested "completed" event before this
            # call resumes (confirmed live: MockRuntimeAdapter.approve_task
            # appends its own "completed" event, and a real Codex approval
            # grant can just as well let the turn finish outright) -- if
            # that nested call already advanced past this step, sending the
            # next step's prompt again here would duplicate it.
            task = self._require_task(db, task.id, "pipeline re-check after approval")
            already_advanced = (task.pipeline_step_index if task.pipeline_step_index is not None else 0) != current_index
            if already_advanced:
                return task
        # else: already "completed" -- the turn simply finished without the
        # runtime ever pausing for a per-action approval, so there is
        # nothing to grant; go straight to advancing.

        if next_index >= len(steps):
            # Last step is done (approved or already completed) -- pipeline
            # finished successfully.
            return task

        next_step = steps[next_index]
        try:
            task = set_task_pipeline_step(db, task, next_index)
            add_conversation_message_for_task(db, task.id, "user", next_step["content"])
            task = await self.followup_task(db, task, next_step["content"])
        except Exception as exc:
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="failed",
                    message=f"Pipeline '{task.pipeline_name}' stopped: could not start step {next_index + 1}/{len(steps)}.",
                    payload={"reason": "pipeline_followup_failed", "error": str(exc)[:500]},
                ),
            )
            return self._require_task(db, task.id, "pipeline followup failure")
        return task


async def stream_task_events(task_id: str) -> AsyncIterator[str]:
    async for payload in broker.subscribe(task_id):
        yield payload
