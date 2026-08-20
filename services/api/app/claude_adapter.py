from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cli_adapter_git import compute_workspace_diff, summarize_stderr_for_failure
from .runtime import RuntimeAdapter, _is_default_model_alias
from .schemas import RuntimeEvent, RuntimeSession, RuntimeSkill, RuntimeStartRequest, TaskDiff


def _claude_bin() -> str:
    configured = os.getenv("CLAUDE_BIN")
    if configured:
        return configured
    local = Path.home() / ".local" / "bin" / "claude"
    return str(local) if local.exists() else "claude"


# `claude` has no `models list`-equivalent subcommand (unlike `grok models` /
# `agy models`), so this is a small hand-maintained catalog of the aliases
# --help itself documents ("an alias for the latest model (e.g. 'fable',
# 'opus', or 'sonnet')") plus haiku. Verified each resolves to a real model
# via a real invocation, not guessed.
KNOWN_MODELS = ["sonnet", "opus", "fable", "haiku"]


@dataclass
class _ClaudeSession:
    working_directory: str
    default_branch: str
    model: str | None
    execution_mode: str
    # Set from `--session-id` on the first turn (a UUID we mint ourselves,
    # matching GrokCliAdapter's approach) and kept in sync from each turn's
    # own `system/init` and `result` events afterwards.
    claude_session_id: str | None = None
    queue: asyncio.Queue[RuntimeEvent] = field(default_factory=asyncio.Queue)
    latest_diff: TaskDiff = field(default_factory=TaskDiff)
    current_process: asyncio.subprocess.Process | None = None


class ClaudeCliAdapter(RuntimeAdapter):
    """Runs Anthropic's own `claude` CLI headlessly as an alternative to the
    Codex App Server.

    Same per-turn subprocess shape as Grok/Antigravity, for the same reason:
    `claude --print` has no persistent server to connect to in headless
    mode, so each turn is one subprocess invocation run to completion.
    Two things set it apart from the other CLI adapters, both confirmed by
    running the real CLI, not by reading docs alone:

    - Its stream-json output already reports a clean, de-duplicated final
      answer per turn as a dedicated terminal `result` event (`result` /
      `is_error`), so there's no need to reassemble one from raw
      text-delta events the way Grok's adapter does -- and no need for
      `--include-partial-messages` at all, which only adds low-level
      `stream_event` chunk noise this adapter never reads.
    - It has a real native plan mode (`--permission-mode plan`) that
      genuinely refuses to write files (confirmed live: asked it to edit a
      file, it produced a plan document and left the file untouched)
      rather than being just a UI toggle with no behavioral effect
      underneath, which is what plan mode is for Grok/Antigravity.
    """

    stream_in_background = True

    def __init__(self) -> None:
        self._sessions: dict[str, _ClaudeSession] = {}

    async def list_collaboration_modes(self) -> list[str] | None:
        return ["plan"]

    async def list_models(self) -> list[str] | None:
        return list(KNOWN_MODELS)

    async def list_skills(self) -> list[RuntimeSkill] | None:
        return None

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        session = _ClaudeSession(
            working_directory=request.working_directory,
            default_branch=request.default_branch,
            model=None if _is_default_model_alias(request.model) else request.model.strip(),
            execution_mode=request.execution_mode,
        )
        self._sessions[request.task_id] = session
        asyncio.create_task(self._run_turn(session, request.prompt, new_session_id=request.task_id))
        return RuntimeSession(session_id=request.task_id, effective_model=session.model or "claude-default")

    async def followup_task(self, session_id: str, message: str, selected_skill: str | None = None) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, message, new_session_id=None))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "claude-default")

    async def retry_task(self, session_id: str) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, "Please try that again.", new_session_id=None))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "claude-default")

    async def stop_task(self, session_id: str) -> None:
        session = self._require_session(session_id)
        if session.current_process is not None and session.current_process.returncode is None:
            session.current_process.terminate()
            await session.queue.put(RuntimeEvent(type="stopped", message="Claude turn stopped"))

    async def approve_task(self, session_id: str) -> None:
        raise RuntimeError(
            "Claude tasks run autonomously (--permission-mode bypassPermissions); there is no pending approval to grant."
        )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        raise RuntimeError("Claude tasks do not pause for user input in headless mode.")

    async def get_diff(self, session_id: str) -> TaskDiff:
        return self._require_session(session_id).latest_diff

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        session = self._require_session(session_id)
        while True:
            yield await session.queue.get()

    def _require_session(self, session_id: str) -> _ClaudeSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise RuntimeError("Unknown Claude session")
        return session

    async def _run_turn(self, session: _ClaudeSession, prompt: str, new_session_id: str | None) -> None:
        # Plan mode is a real CLI feature here (unlike Grok/Antigravity) --
        # confirmed live that `--permission-mode plan` leaves files
        # untouched and instead produces a plan the CLI prints as its final
        # answer, since there's no human present in headless mode to drive
        # the interactive ExitPlanMode approval.
        permission_mode = "plan" if session.execution_mode == "plan" else "bypassPermissions"
        args = [
            _claude_bin(),
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            permission_mode,
        ]
        if session.model:
            args += ["--model", session.model]
        if new_session_id:
            args += ["--session-id", new_session_id]
        elif session.claude_session_id:
            args += ["--resume", session.claude_session_id]
        args += [prompt]

        await session.queue.put(RuntimeEvent(type="agent_status", message="Claude turn started"))

        raw_final_text = ""
        is_error = False
        stderr_tail = b""
        returncode: int | None = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=session.working_directory,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
                # A single NDJSON line can carry a full tool_call's before/
                # after file content, comfortably past asyncio's 64KiB
                # readline() default -- same ceiling hit for real on Grok
                # and Antigravity turns touching a large file.
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
                result = await self._handle_stream_event(session, item)
                if result is not None:
                    raw_final_text, is_error = result
            if proc.stderr is not None:
                stderr_tail = (await proc.stderr.read())[-2000:]
            returncode = await proc.wait()
        except FileNotFoundError:
            await session.queue.put(RuntimeEvent(type="failed", message=f"Claude CLI not found at {_claude_bin()}"))
            return
        except Exception as exc:  # noqa: BLE001 - surface any spawn/stream failure to the UI
            await session.queue.put(RuntimeEvent(type="failed", message=f"Claude turn errored: {exc}"))
            return
        finally:
            session.current_process = None

        raw_final_text = raw_final_text.strip()
        display_text = raw_final_text or "(Claude produced no text response.)"
        await session.queue.put(
            RuntimeEvent(
                type="agent_status",
                message=display_text,
                payload={"source": "agent_message", "full_content": display_text},
            )
        )

        diff = compute_workspace_diff(session.working_directory, session.default_branch, "Claude")
        session.latest_diff = diff
        if diff.files_changed:
            await session.queue.put(RuntimeEvent(type="diff_generated", message=diff.summary, payload=diff.model_dump()))

        if returncode == 0 and not is_error:
            await session.queue.put(RuntimeEvent(type="completed", message="Claude turn completed"))
        else:
            stderr_text = stderr_tail.decode("utf-8", errors="ignore")
            # Claude's own `result` text is usually the actual diagnosis
            # (e.g. "There's an issue with the selected model ...") --
            # confirmed live that stderr is empty even on a real failure
            # (an invalid --model), unlike Grok/Antigravity where stderr is
            # the only place the reason shows up. Prefer it, fall back to
            # stderr for anything that fails before producing a result at
            # all (e.g. a spawn-adjacent error).
            reason = raw_final_text or summarize_stderr_for_failure(stderr_text)
            message = f"Claude exited with code {returncode}"
            if reason:
                message += f": {reason}"
            await session.queue.put(RuntimeEvent(type="failed", message=message, payload={"stderr": stderr_text}))

    async def _handle_stream_event(self, session: _ClaudeSession, item: dict[str, Any]) -> tuple[str, bool] | None:
        """Emits any user-facing event for this stream-json line. Returns
        `(final_text, is_error)` once the terminal `result` event is seen
        (the authoritative source for both -- see the class docstring);
        `None` otherwise."""
        event_type = item.get("type")
        if event_type == "system" and item.get("subtype") == "init":
            session_id = item.get("session_id")
            if isinstance(session_id, str) and session_id:
                session.claude_session_id = session_id
        elif event_type == "assistant":
            for block in item.get("message", {}).get("content", []):
                block_type = block.get("type")
                if block_type == "tool_use":
                    tool_name = block.get("name") or "tool"
                    await session.queue.put(
                        RuntimeEvent(
                            type="command_executed",
                            message=f"Running {tool_name}...",
                            payload=block.get("input"),
                        )
                    )
                elif block_type == "text":
                    text = block.get("text")
                    if isinstance(text, str) and text.strip():
                        await session.queue.put(RuntimeEvent(type="agent_status", message=text))
                # "thinking" blocks are internal reasoning and deliberately
                # not surfaced, matching how Grok/Antigravity treat theirs.
        elif event_type == "result":
            session_id = item.get("session_id")
            if isinstance(session_id, str) and session_id:
                session.claude_session_id = session_id
            result_text = item.get("result")
            return (result_text if isinstance(result_text, str) else ""), bool(item.get("is_error"))
        return None
