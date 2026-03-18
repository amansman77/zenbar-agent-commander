from __future__ import annotations

import asyncio
import os
import subprocess
from collections.abc import AsyncIterator

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import Project, Task
from .repository import (
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
    set_task_workspace,
    set_task_status,
)
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


class TaskOrchestrator:
    ACTIVE_TASK_STATUSES = {"starting", "running", "waiting_user_input", "waiting_result_approval"}

    def __init__(self, adapter: RuntimeAdapter) -> None:
        self.adapter = adapter
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._stream_tasks: dict[str, asyncio.Task[None]] = {}

    def _require_task(self, db: Session, task_id: str, action: str) -> Task:
        refreshed = get_task(db, task_id)
        if refreshed is None:
            raise RuntimeError(f"Task '{task_id}' disappeared while {action}")
        return refreshed

    def ensure_runtime_stream(self, task_id: str, session_id: str | None) -> None:
        if not self.adapter.stream_in_background:
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

    async def start_task(self, db: Session, task: Task, project: Project) -> Task:
        parent_run = get_latest_run(db, task.id)
        create_run(db, task, input_text=task.prompt, parent_run_id=parent_run.id if parent_run else None)
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
        refreshed = self._require_task(db, refreshed.id, "starting runtime session")
        refreshed = set_task_status(
            db,
            refreshed,
            "running",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or resolved_model,
        )
        if self.adapter.stream_in_background:
            self._start_background_consumer(task.id, session.session_id)
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
            refreshed = self._require_task(db, task.id, "clearing stale runtime session")
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "refreshing approval state")
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
            refreshed = self._require_task(db, task.id, "clearing stale runtime session")
            refreshed = clear_runtime_session(db, refreshed)
            raise RuntimeError("Task runtime session is no longer available. Retry the task to continue.") from exc
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "refreshing response state")
        return refreshed

    async def stop_task(self, db: Session, task: Task) -> Task:
        if not task.runtime_session_id:
            raise RuntimeError("Task has no runtime session")
        await self.adapter.stop_task(task.runtime_session_id)
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, task.runtime_session_id)
        db.expire_all()
        refreshed = self._require_task(db, task.id, "stopping task")
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
            refreshed = self._require_task(db, task.id, "applying retry model override")
            if refreshed.runtime_session_id:
                refreshed = clear_runtime_session(db, refreshed, status=refreshed.status)
            return await self._restart_with_fresh_session(db, refreshed)
        if not task.runtime_session_id:
            return await self._restart_with_fresh_session(db, task)
        parent_run = get_latest_run(db, task.id)
        create_run(db, task, input_text="Run again", parent_run_id=parent_run.id if parent_run else None)
        try:
            session = await self.adapter.retry_task(task.runtime_session_id)
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
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
        if self.adapter.stream_in_background:
            self._start_background_consumer(task.id, session.session_id)
        else:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def followup_task(self, db: Session, task: Task, content: str) -> Task:
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
        session = await self.adapter.followup_task(task.runtime_session_id, content)
        refreshed = self._require_task(db, task.id, "starting follow-up turn")
        refreshed = set_task_status(
            db,
            refreshed,
            "running",
            runtime_session_id=session.session_id,
            effective_model=session.effective_model or refreshed.model,
        )
        if not self.adapter.stream_in_background:
            await self._consume_events(task.id, session.session_id)
        return refreshed

    async def refresh_diff(self, db: Session, task: Task) -> Task:
        runtime_diff: TaskDiff | None = None
        if task.runtime_session_id:
            try:
                runtime_diff = await self.adapter.get_diff(task.runtime_session_id)
            except RuntimeError as exc:
                if "Unknown Codex App Server session" not in str(exc):
                    raise

        fallback_diff = await asyncio.to_thread(self._compute_workspace_diff, task)
        chosen = runtime_diff
        if not self._has_diff_content(chosen) and self._has_diff_content(fallback_diff):
            chosen = fallback_diff
        if chosen is None:
            return task

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
            await self.adapter.get_diff(task.runtime_session_id)
            return task
        except RuntimeError as exc:
            if "Unknown Codex App Server session" not in str(exc):
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
            return reconciled

    async def commit_workspace(self, db: Session, task: Task, payload: TaskCommitRequest) -> TaskGitActionResponse:
        if not task.workspace_path:
            raise RuntimeError("Task workspace is not ready")
        result = await asyncio.to_thread(self._commit_workspace_sync, task.workspace_path, payload.message, payload.actor)
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
            self._push_workspace_sync,
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
        if not self.adapter.stream_in_background:
            async for event in self.adapter.subscribe_events(session_id):
                await self._handle_runtime_event(task_id, event)
            return

        attempts = 0
        while True:
            try:
                async for event in self.adapter.subscribe_events(session_id):
                    await self._handle_runtime_event(task_id, event)
                # Re-subscribe if runtime stream ended unexpectedly.
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
                if "Unknown Codex App Server session" in detail:
                    await self._handle_stale_runtime_session(task_id, attempts)
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
            records = list_events(db, task_id)
            latest_event = serialize_event(records[-1])
            payload = {
                "event": latest_event.model_dump(mode="json"),
                "task": serialize_task_detail(task).model_dump(mode="json"),
                "diff": serialize_diff(task).model_dump(mode="json"),
            }
        await broker.publish(task_id, payload)

    def _has_diff_content(self, diff: TaskDiff | None) -> bool:
        if diff is None:
            return False
        if diff.raw_diff and diff.raw_diff.strip():
            return True
        if diff.files_changed:
            return True
        return False

    def _run_git(self, cwd: str, args: list[str]) -> str:
        completed = subprocess.run(
            ["git", "-C", cwd, *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return completed.stdout.strip()

    def _run_git_full(self, cwd: str, args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", cwd, *args],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

    def _git_checked(self, cwd: str, args: list[str], env: dict[str, str] | None = None) -> str:
        completed = self._run_git_full(cwd, args, env=env)
        if completed.returncode != 0:
            message = completed.stderr.strip() or completed.stdout.strip() or f"git {' '.join(args)} failed"
            raise RuntimeError(message)
        return (completed.stdout.strip() or completed.stderr.strip()).strip()

    def _commit_workspace_sync(self, workspace_path: str, message: str, actor: str) -> TaskGitActionResponse:
        self._git_checked(workspace_path, ["rev-parse", "--is-inside-work-tree"])
        status = self._git_checked(workspace_path, ["status", "--porcelain"])
        if not status:
            raise RuntimeError("No changes to commit in Task Workspace")

        self._git_checked(workspace_path, ["add", "-A"])
        env = os.environ.copy()
        if actor.strip():
            name = actor.strip()
            email = os.getenv("ZENBAR_GIT_AUTHOR_EMAIL", "zenbar@local")
            env.setdefault("GIT_AUTHOR_NAME", name)
            env.setdefault("GIT_COMMITTER_NAME", name)
            env.setdefault("GIT_AUTHOR_EMAIL", email)
            env.setdefault("GIT_COMMITTER_EMAIL", email)
        commit_output = self._git_checked(workspace_path, ["commit", "-m", message], env=env)
        branch = self._git_checked(workspace_path, ["rev-parse", "--abbrev-ref", "HEAD"])
        return TaskGitActionResponse(ok=True, branch=branch, message="Committed workspace changes", output=commit_output or None)

    def _push_workspace_sync(self, workspace_path: str, remote: str, set_upstream: bool) -> TaskGitActionResponse:
        branch = self._git_checked(workspace_path, ["rev-parse", "--abbrev-ref", "HEAD"])
        args = ["push"]
        if set_upstream:
            args.append("-u")
        args.extend([remote, branch])
        push_output = self._git_checked(workspace_path, args)
        return TaskGitActionResponse(
            ok=True,
            branch=branch,
            remote=remote,
            message="Pushed workspace branch",
            output=push_output or None,
        )

    def _compute_workspace_diff(self, task: Task) -> TaskDiff | None:
        workspace = task.workspace_path
        if not workspace:
            return None

        try:
            self._run_git(workspace, ["rev-parse", "--is-inside-work-tree"])
        except Exception:
            return None

        files: list[str] = []
        raw_candidates: list[str] = []
        default_branch = task.project.default_branch if task.project else "main"

        def add_files(lines: str) -> None:
            for line in lines.splitlines():
                value = line.strip()
                if value:
                    files.append(value)

        commands: list[tuple[list[str], bool]] = [
            (["diff", "--name-only"], False),
            (["diff", "--cached", "--name-only"], False),
            (["ls-files", "--others", "--exclude-standard"], False),
            (["diff", default_branch, "--name-only"], False),
            (["diff"], True),
            (["diff", "--cached"], True),
            (["diff", default_branch], True),
        ]

        for args, is_raw in commands:
            try:
                output = self._run_git(workspace, args)
            except Exception:
                continue
            if not output:
                continue
            if is_raw:
                raw_candidates.append(output)
            else:
                add_files(output)

        deduped_files = list(dict.fromkeys(files))
        raw_diff = next((item for item in raw_candidates if item.strip()), None)
        if not deduped_files and not raw_diff:
            return None
        summary = f"Updated {len(deduped_files)} file(s) in the Task Workspace."
        return TaskDiff(files_changed=deduped_files, summary=summary, raw_diff=raw_diff)


async def stream_task_events(task_id: str) -> AsyncIterator[str]:
    async for payload in broker.subscribe(task_id):
        yield payload
