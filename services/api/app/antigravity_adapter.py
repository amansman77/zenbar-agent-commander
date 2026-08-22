"""RuntimeAdapter for the Antigravity CLI (`agy`).

Drives one CLI process per task inside the task workspace and reconstructs a
task's events/diff from the transcript files the CLI writes under AGY_HOME.
"""

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
from .schemas import (
    RuntimeEvent,
    RuntimeSession,
    RuntimeSkill,
    RuntimeStartRequest,
    RuntimeUsageInfo,
    RuntimeUsageWindow,
    TaskDiff,
)


def _agy_bin() -> str:
    return os.getenv("AGY_BIN", str(Path.home() / ".local" / "bin" / "agy"))


def _agy_home() -> Path:
    configured = os.getenv("AGY_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".gemini" / "antigravity-cli"


def _last_conversations_file() -> Path:
    return _agy_home() / "cache" / "last_conversations.json"


def _transcript_path(conversation_id: str) -> Path:
    return _agy_home() / "brain" / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"


def _read_conversation_id_for_cwd(cwd: str) -> str | None:
    path = _last_conversations_file()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    value = data.get(cwd)
    return value if isinstance(value, str) else None


def _iter_transcript(conversation_id: str) -> list[dict[str, Any]]:
    path = _transcript_path(conversation_id)
    if not path.exists():
        return []
    items: list[dict[str, Any]] = []
    try:
        raw = path.read_text()
    except OSError:
        return []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return items


def _max_step_index(conversation_id: str | None) -> int:
    if not conversation_id:
        return -1
    max_index = -1
    for item in _iter_transcript(conversation_id):
        idx = item.get("step_index")
        if isinstance(idx, int):
            max_index = max(max_index, idx)
    return max_index


def _last_model_response(conversation_id: str, min_step_index: int = -1) -> str | None:
    """Antigravity's own transcript file is the authoritative source for the
    final assistant text — more reliable than reassembling it from the
    streamed stdout deltas (this mirrors the pattern already proven out in
    the user's own Discord bot integration)."""
    last: str | None = None
    for item in _iter_transcript(conversation_id):
        idx = item.get("step_index")
        content = item.get("content")
        if (
            isinstance(idx, int)
            and idx > min_step_index
            and item.get("source") == "MODEL"
            and item.get("type") == "PLANNER_RESPONSE"
            and item.get("status") == "DONE"
            and isinstance(content, str)
            and content.strip()
        ):
            last = content
    return last


# `agy -p "/usage" --output-format json` answers with real structured JSON
# (unlike Claude's plain-prose /usage) -- confirmed live this is a free,
# local status answer (num_turns: 0), grouped per model family since
# Antigravity meters Gemini and Claude/GPT-family models separately:
#   {"command": {"data": {"groups": [
#     {"name": "Gemini Models", "buckets": [
#       {"window": "weekly", "remaining_fraction": 0.999, "reset_time": "..."},
#       {"window": "5h", "remaining_fraction": 1.0, "reset_time": "..."}]},
#     {"name": "Claude and GPT models", "buckets": [...]}]}}}
# RuntimeUsageInfo only has one session/week slot, so this picks the *worst*
# (most-used) group per window and names it in the label -- a single number
# an "am I about to hit a wall" glance still needs, without silently hiding
# that one group might be far more depleted than another.
def _worst_agy_bucket(groups: list[dict[str, Any]], window: str) -> RuntimeUsageWindow | None:
    worst: tuple[int, Any] | None = None  # (percent_used, bucket)
    for group in groups:
        if not isinstance(group, dict):
            continue
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict) or bucket.get("window") != window:
                continue
            remaining = bucket.get("remaining_fraction")
            if not isinstance(remaining, (int, float)):
                continue
            percent_used = round((1 - remaining) * 100)
            if worst is None or percent_used > worst[0]:
                worst = (percent_used, {**bucket, "_group_name": group.get("name")})
    if worst is None:
        return None
    percent_used, bucket = worst
    reset_time = bucket.get("reset_time")
    group_name = bucket.get("_group_name")
    label_parts = [part for part in (reset_time, f"({group_name})" if group_name else None) if part]
    # reset_time is already ISO 8601 ("2026-08-22T09:06:06Z") straight from
    # the CLI's own JSON, unlike Claude's free-text prose -- passed through
    # as-is for the frontend's countdown, no reformatting needed.
    resets_at = reset_time if isinstance(reset_time, str) and reset_time else None
    return RuntimeUsageWindow(percent_used=percent_used, resets_label=" ".join(label_parts) or None, resets_at=resets_at)


def _parse_agy_usage_output(stdout_text: str) -> RuntimeUsageInfo | None:
    try:
        payload = json.loads(stdout_text.strip())
    except json.JSONDecodeError:
        return None
    groups = ((payload.get("command") or {}).get("data") or {}).get("groups")
    if not isinstance(groups, list):
        return None
    session_window = _worst_agy_bucket(groups, "5h")
    week_window = _worst_agy_bucket(groups, "weekly")
    if session_window is None and week_window is None:
        return None
    return RuntimeUsageInfo(session=session_window, week=week_window)


@dataclass
class _AntigravitySession:
    working_directory: str
    default_branch: str
    model: str | None
    conversation_id: str | None = None
    queue: asyncio.Queue[RuntimeEvent] = field(default_factory=asyncio.Queue)
    latest_diff: TaskDiff = field(default_factory=TaskDiff)
    current_process: asyncio.subprocess.Process | None = None


class AntigravityCliAdapter(RuntimeAdapter):
    """Runs Google Antigravity's `agy` CLI headlessly as an alternative to the
    Codex App Server.

    Unlike Codex's app-server, `agy` has no persistent process to connect to
    and no mid-task approval round-trip in headless/print mode — each turn is
    a single subprocess invocation that runs to completion with
    `--dangerously-skip-permissions` (headless mode auto-denies any tool that
    would otherwise need a permission prompt, so there is no useful
    "unattended but still asks for risky actions" middle ground). Follow-up
    turns resume the same conversation via `--conversation <id>`, using the
    id agy records for us in its `last_conversations.json` cache (keyed by
    the exact --cwd used) after the first turn.
    """

    stream_in_background = True

    def __init__(self) -> None:
        self._sessions: dict[str, _AntigravitySession] = {}

    async def list_collaboration_modes(self) -> list[str] | None:
        return ["plan"]

    async def list_models(self) -> list[str] | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                _agy_bin(),
                "models",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        except (OSError, asyncio.TimeoutError):
            return None
        models: list[str] = []
        for line in stdout.decode("utf-8", errors="ignore").splitlines():
            model_id = line.split("\t")[0].strip()
            if model_id and not model_id.lower().startswith("fetching"):
                models.append(model_id)
        return models or None

    async def list_skills(self) -> list[RuntimeSkill] | None:
        return None

    async def get_usage(self) -> RuntimeUsageInfo | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                _agy_bin(),
                "-p",
                "/usage",
                "--output-format",
                "json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        except (OSError, asyncio.TimeoutError):
            return None
        return _parse_agy_usage_output(stdout.decode("utf-8", errors="ignore"))

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        session = _AntigravitySession(
            working_directory=request.working_directory,
            default_branch=request.default_branch,
            model=None if _is_default_model_alias(request.model) else request.model.strip(),
        )
        self._sessions[request.task_id] = session
        asyncio.create_task(self._run_turn(session, request.prompt, is_followup=False))
        return RuntimeSession(session_id=request.task_id, effective_model=session.model or "antigravity-default")

    async def followup_task(self, session_id: str, message: str, selected_skill: str | None = None) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, message, is_followup=True))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "antigravity-default")

    async def retry_task(self, session_id: str) -> RuntimeSession:
        session = self._require_session(session_id)
        asyncio.create_task(self._run_turn(session, "Please try that again.", is_followup=True))
        return RuntimeSession(session_id=session_id, effective_model=session.model or "antigravity-default")

    async def stop_task(self, session_id: str) -> None:
        session = self._require_session(session_id)
        if session.current_process is not None and session.current_process.returncode is None:
            session.current_process.terminate()
            await session.queue.put(RuntimeEvent(type="stopped", message="Antigravity turn stopped"))

    async def approve_task(self, session_id: str) -> None:
        raise RuntimeError(
            "Antigravity tasks run autonomously (--dangerously-skip-permissions); there is no pending approval to grant."
        )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        raise RuntimeError("Antigravity tasks do not pause for user input in headless mode.")

    async def get_diff(self, session_id: str) -> TaskDiff:
        return self._require_session(session_id).latest_diff

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        session = self._require_session(session_id)
        while True:
            yield await session.queue.get()

    def _require_session(self, session_id: str) -> _AntigravitySession:
        session = self._sessions.get(session_id)
        if session is None:
            raise RuntimeError("Unknown Antigravity session")
        return session

    async def _run_turn(self, session: _AntigravitySession, prompt: str, is_followup: bool) -> None:
        args = [
            _agy_bin(),
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "--print-timeout",
            "20m",
        ]
        if session.model:
            args += ["--model", session.model]
        if is_followup and session.conversation_id:
            args += ["--conversation", session.conversation_id]
        else:
            # Without --new-project, agy operates on its own persistent global
            # "scratch" workspace instead of --cwd — verified empirically, not
            # documented. Only pass it on the first turn: once a conversation
            # exists, --conversation alone keeps it correctly scoped to the
            # same directory.
            args += ["--new-project"]
        args += ["--print", prompt]

        before_step_index = _max_step_index(session.conversation_id)
        await session.queue.put(RuntimeEvent(type="agent_status", message="Antigravity turn started"))

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
            await session.queue.put(
                RuntimeEvent(type="failed", message=f"Antigravity CLI not found at {_agy_bin()}")
            )
            return
        except Exception as exc:  # noqa: BLE001 - surface any spawn/stream failure to the UI
            await session.queue.put(RuntimeEvent(type="failed", message=f"Antigravity turn errored: {exc}"))
            return
        finally:
            session.current_process = None

        conversation_id = _read_conversation_id_for_cwd(session.working_directory) or session.conversation_id
        session.conversation_id = conversation_id

        final_text = None
        if conversation_id:
            final_text = _last_model_response(conversation_id, before_step_index)
        final_text = final_text or text_buffer.strip() or "(Antigravity produced no text response.)"

        await session.queue.put(
            RuntimeEvent(
                type="agent_status",
                message=final_text,
                payload={"source": "agent_message", "full_content": final_text},
            )
        )

        diff = compute_workspace_diff(session.working_directory, session.default_branch, "Antigravity")
        session.latest_diff = diff
        if diff.files_changed:
            await session.queue.put(
                RuntimeEvent(type="diff_generated", message=diff.summary, payload=diff.model_dump())
            )

        if returncode == 0:
            await session.queue.put(RuntimeEvent(type="completed", message="Antigravity turn completed"))
        else:
            stderr_text = stderr_tail.decode("utf-8", errors="ignore")
            reason = summarize_stderr_for_failure(stderr_text)
            message = f"Antigravity exited with code {returncode}"
            if reason:
                message += f": {reason}"
            await session.queue.put(
                RuntimeEvent(type="failed", message=message, payload={"stderr": stderr_text})
            )

    async def _handle_stream_event(self, session: _AntigravitySession, item: dict[str, Any], text_buffer: str) -> str:
        event_type = item.get("event")
        if event_type == "step_update":
            step = item.get("step_update") or {}
            step_type = step.get("step_type")
            state = step.get("state")
            if step_type == "agent_response":
                delta = step.get("text_delta")
                if isinstance(delta, str) and delta:
                    text_buffer += delta
                    await session.queue.put(RuntimeEvent(type="agent_status", message=text_buffer))
            elif step_type == "tool":
                tool_name = step.get("tool_name") or "tool"
                if state == "ACTIVE":
                    await session.queue.put(
                        RuntimeEvent(type="command_executed", message=f"Running {tool_name}...", payload=step.get("tool_info"))
                    )
                elif state == "ERROR":
                    tool_info = step.get("tool_info") or {}
                    error = (tool_info.get("error") or {}).get("message") or "Tool call failed"
                    await session.queue.put(
                        RuntimeEvent(type="agent_status", message=f"{tool_name} failed: {error}")
                    )
        return text_buffer
