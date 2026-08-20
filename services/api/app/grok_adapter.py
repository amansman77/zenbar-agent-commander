from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cli_adapter_git import compute_workspace_diff
from .runtime import RuntimeAdapter, _is_default_model_alias
from .schemas import RuntimeEvent, RuntimeSession, RuntimeSkill, RuntimeStartRequest, TaskDiff


def _grok_bin() -> str:
    configured = os.getenv("GROK_BIN")
    if configured:
        return configured
    local = Path.home() / ".local" / "bin" / "grok"
    return str(local) if local.exists() else "grok"


def _parse_models_output(text: str) -> list[str]:
    """`grok models` prints prose, not a machine format: a couple of header
    lines ("You are logged in...", "Default model: ..."), then one
    "  * <id> (default)" / "  - <id>" line per available model."""
    models: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped[0] not in "*-":
            continue
        model_id = stripped.lstrip("*-").strip().split(" ")[0].strip()
        if model_id:
            models.append(model_id)
    return models


@dataclass
class _GrokSession:
    working_directory: str
    default_branch: str
    model: str | None
    # Set from `--session-id` on the first turn (a UUID we mint ourselves,
    # since Grok accepts a caller-supplied one for a *new* conversation) and
    # confirmed/kept in sync from each turn's own "end" event afterwards.
    grok_session_id: str | None = None
    queue: asyncio.Queue[RuntimeEvent] = field(default_factory=asyncio.Queue)
    latest_diff: TaskDiff = field(default_factory=TaskDiff)
    current_process: asyncio.subprocess.Process | None = None


class GrokCliAdapter(RuntimeAdapter):
    """Runs xAI's official `grok` CLI headlessly as an alternative to the
    Codex App Server.

    Same shape as AntigravityCliAdapter and for the same reason: `grok` (like
    `agy`) has no persistent server to connect to in headless mode, so each
    turn is one subprocess invocation run to completion with
    `--permission-mode bypassPermissions` (no interactive approval
    round-trip). Unlike Antigravity, Grok's own streaming stdout is the
    authoritative transcript -- there's no separate log file to cross-check
    against, and the CLI accepts a caller-supplied `--session-id` for a new
    conversation, so the zenbar task id can be used directly instead of
    reading a session id back out of some external state file.
    """

    stream_in_background = True

    def __init__(self) -> None:
        self._sessions: dict[str, _GrokSession] = {}

    async def list_collaboration_modes(self) -> list[str] | None:
        return None

    async def list_models(self) -> list[str] | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                _grok_bin(),
                "models",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        except (OSError, asyncio.TimeoutError):
            return None
        models = _parse_models_output(stdout.decode("utf-8", errors="ignore"))
        return models or None

    async def list_skills(self) -> list[RuntimeSkill] | None:
        return None

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        session = _GrokSession(
            working_directory=request.working_directory,
            default_branch=request.default_branch,
            model=None if _is_default_model_alias(request.model) else request.model.strip(),
            grok_session_id=request.task_id,
        )
        self._sessions[request.task_id] = session
        asyncio.create_task(self._run_turn(session, request.prompt, new_session_id=request.task_id))
        return RuntimeSession(session_id=request.task_id, effective_model=session.model or "grok-default")

    async def followup_task(self, session_id: str, message: str, selected_skill: str | None = None) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, message, new_session_id=None))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "grok-default")

    async def retry_task(self, session_id: str) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, "Please try that again.", new_session_id=None))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "grok-default")

    async def stop_task(self, session_id: str) -> None:
        session = self._require_session(session_id)
        if session.current_process is not None and session.current_process.returncode is None:
            session.current_process.terminate()
            await session.queue.put(RuntimeEvent(type="stopped", message="Grok turn stopped"))

    async def approve_task(self, session_id: str) -> None:
        raise RuntimeError(
            "Grok tasks run autonomously (--permission-mode bypassPermissions); there is no pending approval to grant."
        )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        raise RuntimeError("Grok tasks do not pause for user input in headless mode.")

    async def get_diff(self, session_id: str) -> TaskDiff:
        return self._require_session(session_id).latest_diff

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        session = self._require_session(session_id)
        while True:
            yield await session.queue.get()

    def _require_session(self, session_id: str) -> _GrokSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise RuntimeError("Unknown Grok session")
        return session

    async def _run_turn(self, session: _GrokSession, prompt: str, new_session_id: str | None) -> None:
        args = [
            _grok_bin(),
            "--permission-mode",
            "bypassPermissions",
            "--output-format",
            "streaming-json",
            "--cwd",
            session.working_directory,
        ]
        if session.model:
            args += ["--model", session.model]
        if new_session_id:
            args += ["--session-id", new_session_id]
        elif session.grok_session_id:
            args += ["--resume", session.grok_session_id]
        args += ["-p", prompt]

        await session.queue.put(RuntimeEvent(type="agent_status", message="Grok turn started"))

        text_buffer = ""
        stderr_tail = b""
        returncode: int | None = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=session.working_directory,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
                # A single NDJSON line can carry a full tool_call_update --
                # e.g. a large file's complete before/after content in a
                # write diff -- comfortably past asyncio's 64KiB default
                # readline() limit. Hit for real: a Grok turn on a large
                # file failed with "Separator is found, but chunk is longer
                # than limit" (asyncio.LimitOverrunError). Same readline()
                # loop shape here, so the same ceiling applies.
                limit=1024 * 1024 * 20,
            )
            session.current_process = proc
            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                try:
                    item = json.loads(line.decode("utf-8", errors="ignore"))
                except json.JSONDecodeError:
                    continue
                text_buffer = await self._handle_stream_event(session, item, text_buffer)
            if proc.stderr is not None:
                stderr_tail = (await proc.stderr.read())[-2000:]
            returncode = await proc.wait()
        except FileNotFoundError:
            await session.queue.put(RuntimeEvent(type="failed", message=f"Grok CLI not found at {_grok_bin()}"))
            return
        except Exception as exc:  # noqa: BLE001 - surface any spawn/stream failure to the UI
            await session.queue.put(RuntimeEvent(type="failed", message=f"Grok turn errored: {exc}"))
            return
        finally:
            session.current_process = None

        final_text = text_buffer.strip() or "(Grok produced no text response.)"
        await session.queue.put(
            RuntimeEvent(
                type="agent_status",
                message=final_text,
                payload={"source": "agent_message", "full_content": final_text},
            )
        )

        diff = compute_workspace_diff(session.working_directory, session.default_branch, "Grok")
        session.latest_diff = diff
        if diff.files_changed:
            await session.queue.put(RuntimeEvent(type="diff_generated", message=diff.summary, payload=diff.model_dump()))

        if returncode == 0:
            await session.queue.put(RuntimeEvent(type="completed", message="Grok turn completed"))
        else:
            await session.queue.put(
                RuntimeEvent(
                    type="failed",
                    message=f"Grok exited with code {returncode}",
                    payload={"stderr": stderr_tail.decode("utf-8", errors="ignore")},
                )
            )

    async def _handle_stream_event(self, session: _GrokSession, item: dict[str, Any], text_buffer: str) -> str:
        event_type = item.get("type")
        if event_type == "text":
            delta = item.get("data")
            if isinstance(delta, str) and delta:
                text_buffer += delta
                await session.queue.put(RuntimeEvent(type="agent_status", message=text_buffer))
        elif event_type == "tool_call":
            title = item.get("title") or item.get("toolName") or "tool"
            await session.queue.put(RuntimeEvent(type="command_executed", message=f"Running {title}...", payload=item.get("rawInput")))
        elif event_type == "end":
            # The authoritative session id for --resume going forward. In
            # practice this always matches whatever --session-id/--resume we
            # passed in, but trusting the CLI's own report is safer than
            # assuming that held.
            session_id = item.get("sessionId")
            if isinstance(session_id, str) and session_id:
                session.grok_session_id = session_id
        # "thought" (chain-of-thought deltas) and "available_commands" /
        # "usage" (bookkeeping, repeated verbatim throughout the stream) are
        # deliberately not surfaced as events -- the former is noisy internal
        # reasoning, the latter has no user-facing meaning.
        return text_buffer
