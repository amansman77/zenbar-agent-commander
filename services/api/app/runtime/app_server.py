"""RuntimeAdapter for the Codex App Server — the default engine.

Speaks JSON-RPC over a WebSocket to a running App Server process, keeping one
SessionState per task (thread id, buffered agent message, pending approval
requests) and translating the server's notifications into RuntimeEvents.
"""

from __future__ import annotations

import asyncio
import json
import os
import websockets

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from itertools import count
from typing import Any
from websockets.asyncio.client import ClientConnection

from ..codex_profiles import get_profile
from ..schemas import (
    RuntimeEvent,
    RuntimeSession,
    RuntimeSkill,
    RuntimeStartRequest,
    RuntimeUsageInfo,
    TaskDiff,
)
from .base import RuntimeAdapter, _prompt_with_workspace, is_default_model_alias
from .diffs import _build_diff_payload, _coerce_diff_text, _extract_diff_payload
from .usage import _classify_rate_limit_windows

def _sandbox_policy_for_mode(mode: str, working_directory: str) -> dict[str, Any]:
    if mode == "read-only":
        return {"type": "readOnly", "networkAccess": False}
    if mode == "danger-full-access":
        return {"type": "dangerFullAccess"}
    return {
        "type": "workspaceWrite",
        "writableRoots": [working_directory],
        "readOnlyAccess": {"type": "fullAccess"},
        "networkAccess": False,
        "excludeTmpdirEnvVar": False,
        "excludeSlashTmp": False,
    }


def _extract_assistant_text_from_items(items: list[Any]) -> str:
    parts: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type", "")
        item_role = item.get("role", "")
        is_assistant = (
            item_type in {"message", "assistantMessage", "assistant_message", "agentMessage"}
            or item_role == "assistant"
        )
        if not is_assistant:
            continue
        content = item.get("content") or []
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                    text = block.get("text", "")
                    if text:
                        parts.append(text)
    return "\n".join(parts).strip()


def _is_unsupported_model_error(message: str) -> bool:
    lowered = message.lower()
    return "model is not supported" in lowered or "not supported when using codex with a chatgpt account" in lowered


# `account/rateLimits/read`'s `primary`/`secondary` RateLimitWindow fields
# aren't labeled "session" vs "week" -- only distinguishable by
# windowDurationMins. Verified live against the real running App Server:
# a weekly window reported 10080 (= 7 * 24 * 60). No 5h-window example was
# available to confirm its exact minute count, so this classifies by
# threshold (<=360 min ~ session-scale, >=10000 min ~ week-scale) rather
# than an exact match, and drops anything in between as unrecognized.


@dataclass
class PendingRequest:
    request_id: int | str
    method: str
    params: dict[str, Any]
    interaction_type: str


@dataclass
class SessionState:
    thread_id: str
    queue: asyncio.Queue[RuntimeEvent] = field(default_factory=asyncio.Queue)
    current_turn_id: str | None = None
    latest_diff: TaskDiff = field(default_factory=TaskDiff)
    pending_requests: dict[int | str, PendingRequest] = field(default_factory=dict)
    start_request: RuntimeStartRequest | None = None
    agent_message_buffer: str = ""


class AppServerWebSocketAdapter(RuntimeAdapter):
    def __init__(self, url: str) -> None:
        self._url = url
        self._connection: ClientConnection | None = None
        self._connection_lock = asyncio.Lock()
        self._request_ids = count(1)
        self._pending_responses: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._sessions: dict[str, SessionState] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._initialized = False
        self._idle_event_heartbeat_seconds = float(os.getenv("ZENBAR_RUNTIME_IDLE_HEARTBEAT_SECONDS", "30"))

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        await self._ensure_connection()
        requested_model = request.model.strip()
        used_runtime_default = is_default_model_alias(requested_model)
        profile = get_profile(request.profile)
        thread_start_params: dict[str, Any] = {
            "cwd": request.working_directory,
            "approvalPolicy": (profile.approval_policy if profile else None) or "on-request",
            "sandbox": (profile.sandbox_mode if profile else None) or "workspace-write",
            "personality": (profile.personality if profile else None) or "pragmatic",
        }
        if profile and profile.model_provider:
            thread_start_params["modelProvider"] = profile.model_provider
        if profile and profile.model:
            # A profile owns the model it declares; it wins over an explicit
            # model pick, matching what Codex CLI's --profile does.
            thread_start_params["model"] = profile.model
            used_runtime_default = False
        elif not used_runtime_default:
            thread_start_params["model"] = requested_model
        try:
            thread = await self._rpc("thread/start", thread_start_params)
        except RuntimeError as exc:
            if used_runtime_default or not _is_unsupported_model_error(str(exc)):
                raise
            # Some account types reject explicit model IDs. Retry with runtime default model.
            retry_params = dict(thread_start_params)
            retry_params.pop("model", None)
            thread = await self._rpc("thread/start", retry_params)
            used_runtime_default = True
        thread_id = thread["thread"]["id"]
        state = SessionState(thread_id=thread_id, start_request=request)
        self._sessions[thread_id] = state
        turn = await self._rpc("turn/start", self._build_turn_start_params(thread_id, request))
        state.current_turn_id = turn["turn"]["id"]
        if used_runtime_default and not is_default_model_alias(requested_model):
            await state.queue.put(
                RuntimeEvent(
                    type="agent_status",
                    message=f"Requested model '{requested_model}' is unsupported for this account. Started with runtime default model.",
                    payload={
                        "type": "model_defaulted",
                        "reason": "unsupported_requested_model",
                        "requested_model": requested_model,
                        "model": thread.get("model") or "runtime-default",
                    },
                )
            )
        await state.queue.put(RuntimeEvent(type="agent_status", message="Codex App Server turn started"))
        effective_model = thread.get("model") or ("runtime-default" if used_runtime_default else requested_model)
        return RuntimeSession(session_id=thread_id, effective_model=effective_model)

    async def list_collaboration_modes(self) -> list[str] | None:
        try:
            result = await self._rpc("collaborationMode/list", {})
        except RuntimeError as exc:
            message = str(exc).lower()
            if "method not found" in message or "unknown method" in message or "not supported" in message:
                return None
            raise
        modes = result.get("modes")
        if not isinstance(modes, list):
            return None
        supported: list[str] = []
        for item in modes:
            if isinstance(item, dict) and isinstance(item.get("mode"), str):
                supported.append(item["mode"])
        return supported or None

    async def list_models(self) -> list[str] | None:
        try:
            result = await self._rpc("model/list", {})
        except RuntimeError as exc:
            message = str(exc).lower()
            if "method not found" in message or "unknown method" in message or "not supported" in message:
                return None
            raise
        # Response: {"data": [{"id": "...", "hidden": bool, ...}], "nextCursor": ...}
        raw_items = result.get("data", [])
        if not isinstance(raw_items, list):
            raw_items = []
        models: list[str] = []
        for item in raw_items:
            if isinstance(item, str) and item.strip():
                models.append(item.strip())
                continue
            if isinstance(item, dict):
                if item.get("hidden"):
                    continue
                model_id = item.get("id") or item.get("model")
                if isinstance(model_id, str) and model_id.strip():
                    models.append(model_id.strip())
        return list(dict.fromkeys(models)) or None

    async def list_skills(self) -> list[RuntimeSkill] | None:
        try:
            result = await self._rpc("skills/list", {})
        except RuntimeError as exc:
            message = str(exc).lower()
            if "method not found" in message or "unknown method" in message or "not supported" in message:
                return None
            raise
        # Response: {"data": [{"cwd": "...", "skills": [...], "errors": [...]}]}
        raw_items: list[Any] = []
        for entry in result.get("data", []):
            if isinstance(entry, dict):
                raw_items.extend(entry.get("skills", []))
        if not raw_items:
            return None
        skills: list[RuntimeSkill] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            if not item.get("enabled", True):
                continue
            skill_id = item.get("name", "").strip()
            if not skill_id:
                continue
            iface = item.get("interface") or {}
            display_name = iface.get("displayName") or skill_id
            description = item.get("description")
            skills.append(RuntimeSkill(id=skill_id, name=display_name, description=description))
        return skills or None

    async def get_usage(self) -> RuntimeUsageInfo | None:
        try:
            result = await self._rpc("account/rateLimits/read", None)
        except RuntimeError:
            return None
        snapshot = result.get("rateLimits")
        if not isinstance(snapshot, dict):
            return None
        session_window, week_window = _classify_rate_limit_windows(snapshot.get("primary"), snapshot.get("secondary"))
        if session_window is None and week_window is None:
            return None
        return RuntimeUsageInfo(session=session_window, week=week_window)

    async def stop_task(self, session_id: str) -> None:
        state = self._require_session(session_id)
        if state.current_turn_id is None:
            return
        await self._rpc("turn/interrupt", {"threadId": session_id, "turnId": state.current_turn_id})

    async def approve_task(self, session_id: str) -> None:
        state = self._require_session(session_id)
        pending_items = [item for item in state.pending_requests.values() if item.interaction_type == "result_approval"]
        if not pending_items:
            raise RuntimeError("No pending result approval request")
        for pending in pending_items:
            result = self._approval_result_for(pending)
            await self._send_json({"jsonrpc": "2.0", "id": pending.request_id, "result": result})
            state.pending_requests.pop(pending.request_id, None)
            await state.queue.put(
                RuntimeEvent(
                    type="result_approval_granted",
                    message="Result approval granted",
                    payload={"request_id": pending.request_id, "method": pending.method},
                )
            )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        state = self._require_session(session_id)
        pending = self._find_pending_request(state, request_id)
        if pending is None or pending.interaction_type != "user_input":
            raise RuntimeError("No pending user input request")
        await self._send_json(
            {
                "jsonrpc": "2.0",
                "id": pending.request_id,
                "result": {"answers": {question_id: {"answers": value} for question_id, value in answers.items()}},
            }
        )
        state.pending_requests.pop(pending.request_id, None)
        await state.queue.put(
            RuntimeEvent(
                type="user_input_submitted",
                message="User input submitted",
                payload={"request_id": pending.request_id, "answers": answers},
            )
        )

    async def retry_task(self, session_id: str) -> RuntimeSession:
        state = self._require_session(session_id)
        if state.start_request is None:
            raise RuntimeError("Retry unavailable because original task request is missing")
        turn = await self._rpc("turn/start", self._build_turn_start_params(session_id, state.start_request))
        state.current_turn_id = turn["turn"]["id"]
        state.pending_requests.clear()
        state.latest_diff = TaskDiff()
        await state.queue.put(RuntimeEvent(type="agent_status", message="Retry turn started in Codex App Server"))
        requested = state.start_request.model if state.start_request else None
        return RuntimeSession(session_id=session_id, effective_model=requested)

    async def followup_task(self, session_id: str, message: str, selected_skill: str | None = None) -> RuntimeSession:
        state = self._require_session(session_id)
        request = state.start_request
        if request is None:
            raise RuntimeError("Follow-up unavailable because original task request is missing")
        params = self._build_turn_start_params(session_id, request)
        full_message = f"[Skill: {selected_skill}]\n{message}" if selected_skill else message
        params["input"] = [{"type": "text", "text": full_message, "text_elements": []}]
        turn = await self._rpc("turn/start", params)
        state.current_turn_id = turn["turn"]["id"]
        state.pending_requests.clear()
        await state.queue.put(RuntimeEvent(type="agent_status", message="Follow-up turn started in Codex App Server"))
        return RuntimeSession(session_id=session_id, effective_model=request.model)

    def _build_turn_start_params(
        self,
        thread_id: str,
        request: RuntimeStartRequest,
    ) -> dict[str, Any]:
        profile = get_profile(request.profile)
        sandbox_mode = (profile.sandbox_mode if profile else None) or "workspace-write"
        params: dict[str, Any] = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": _prompt_with_workspace(request), "text_elements": []}],
            "collaborationMode": (
                {
                    "mode": "plan",
                    "settings": {
                        "model": (profile.model if profile and profile.model else None) or (
                            None if is_default_model_alias(request.model) else request.model
                        ),
                        "developer_instructions": None,
                        "reasoning_effort": request.reasoning_effort,
                    },
                }
                if request.execution_mode == "plan"
                else None
            ),
            "sandboxPolicy": _sandbox_policy_for_mode(sandbox_mode, request.working_directory),
            "approvalPolicy": (profile.approval_policy if profile else None) or "on-request",
            "personality": (profile.personality if profile else None) or "pragmatic",
        }
        if profile and profile.model:
            # A profile owns the model it declares; it wins over an explicit
            # model pick, matching what Codex CLI's --profile does.
            params["model"] = profile.model
        if profile and profile.reasoning_effort:
            params["effort"] = profile.reasoning_effort
        return params

    async def get_diff(self, session_id: str) -> TaskDiff:
        return self._require_session(session_id).latest_diff

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        state = self._require_session(session_id)
        while True:
            try:
                yield await asyncio.wait_for(state.queue.get(), timeout=self._idle_event_heartbeat_seconds)
            except asyncio.TimeoutError:
                reader = self._reader_task
                if reader is not None and reader.done():
                    error = reader.exception()
                    if error is not None:
                        raise RuntimeError(f"Codex App Server stream reader failed: {error}") from error
                    raise RuntimeError("Codex App Server stream reader stopped")
                yield RuntimeEvent(
                    type="agent_status",
                    message="Runtime is still running (no new output yet).",
                    payload={"reason": "idle_heartbeat"},
                )

    async def _ensure_connection(self) -> None:
        async with self._connection_lock:
            if self._connection is not None and self._connection.state.name == "OPEN" and self._initialized:
                return
            self._connection = await websockets.connect(self._url)
            self._reader_task = asyncio.create_task(self._reader_loop())
            request_id = next(self._request_ids)
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending_responses[request_id] = future
            await self._send_json(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {"name": "zenbar-agent-commander", "version": "0.1.0"},
                        "capabilities": {"experimentalApi": True},
                    },
                }
            )
            response = await future
            if "error" in response:
                raise RuntimeError(response["error"].get("message", "Failed to initialize Codex App Server"))
            self._initialized = True

    async def _rpc(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        await self._ensure_connection()
        request_id = next(self._request_ids)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending_responses[request_id] = future
        await self._send_json({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        response = await future
        if "error" in response:
            raise RuntimeError(response["error"].get("message", "Unknown Codex App Server error"))
        return response["result"]

    async def _send_json(self, payload: dict[str, Any]) -> None:
        if self._connection is None:
            raise RuntimeError("Codex App Server connection is not initialized")
        await self._connection.send(json.dumps(payload))

    async def _reader_loop(self) -> None:
        assert self._connection is not None
        async for message in self._connection:
            payload = json.loads(message)
            if "id" in payload and ("result" in payload or "error" in payload):
                future = self._pending_responses.pop(payload["id"], None)
                if future is not None and not future.done():
                    future.set_result(payload)
                continue
            method = payload.get("method")
            if method is None:
                continue
            if "id" in payload:
                await self._handle_server_request(payload)
            else:
                await self._handle_notification(payload)

    async def _handle_server_request(self, payload: dict[str, Any]) -> None:
        method = payload["method"]
        params = payload.get("params", {})
        thread_id = params.get("threadId")
        if thread_id is None or thread_id not in self._sessions:
            return
        state = self._sessions[thread_id]
        request_id = payload["id"]
        if method == "item/tool/requestUserInput":
            state.pending_requests[request_id] = PendingRequest(
                request_id=request_id,
                method=method,
                params=params,
                interaction_type="user_input",
            )
            await state.queue.put(
                RuntimeEvent(
                    type="user_input_requested",
                    message=f"User input requested: {len(params.get('questions', []))} question(s)",
                    payload={"request_id": request_id, "method": method, **params},
                )
            )
            return
        if method in {"item/fileChange/requestApproval", "item/commandExecution/requestApproval"}:
            state.pending_requests[request_id] = PendingRequest(
                request_id=request_id,
                method=method,
                params=params,
                interaction_type="result_approval",
            )
            if method == "item/fileChange/requestApproval":
                diff_payload = _extract_diff_payload(params)
                if diff_payload is not None:
                    state.latest_diff = diff_payload
                    await state.queue.put(
                        RuntimeEvent(
                            type="diff_generated",
                            message=diff_payload.summary,
                            payload=diff_payload.model_dump(),
                        )
                    )
                    for file_path in diff_payload.files_changed:
                        await state.queue.put(RuntimeEvent(type="file_changed", message=file_path, payload={"file": file_path}))
            message = params.get("reason") or params.get("command") or f"Result approval requested: {method}"
            await state.queue.put(
                RuntimeEvent(
                    type="result_approval_requested",
                    message=message,
                    payload={"request_id": request_id, "method": method, **params},
                )
            )
            return
        await state.queue.put(
            RuntimeEvent(type="agent_status", message=f"Unhandled server request: {method}", payload={"method": method, **params})
        )

    async def _handle_notification(self, payload: dict[str, Any]) -> None:
        method = payload["method"]
        params = payload.get("params", {})
        thread_id = (
            params.get("threadId")
            or params.get("conversationId")
            or params.get("thread_id")
            or params.get("session_id")
        )
        if method.startswith("codex/event/"):
            thread_id = params.get("conversationId") or thread_id
        if thread_id is None or thread_id not in self._sessions:
            return
        state = self._sessions[thread_id]

        if method == "thread/status/changed":
            status = params.get("status", {})
            active_flags = status.get("activeFlags", [])
            if "waitingOnApproval" in active_flags and state.pending_requests:
                return
            if "waitingOnApproval" in active_flags:
                await state.queue.put(RuntimeEvent(type="agent_status", message="Codex App Server is waiting on user interaction"))
            else:
                await state.queue.put(RuntimeEvent(type="agent_status", message=f"Thread status: {status.get('type', 'unknown')}"))
            return

        if method == "turn/started":
            turn = params.get("turn", {})
            state.current_turn_id = turn.get("id")
            await state.queue.put(RuntimeEvent(type="agent_status", message="Turn started"))
            return

        if method == "turn/completed":
            turn = params.get("turn", {})
            state.current_turn_id = turn.get("id", state.current_turn_id)
            if turn.get("error"):
                await state.queue.put(RuntimeEvent(type="failed", message=json.dumps(turn["error"])))
            else:
                # Extract assistant text from turn items (for models that don't emit agent_message events)
                items = turn.get("items") or []
                assistant_text = _extract_assistant_text_from_items(items)
                if assistant_text:
                    await state.queue.put(RuntimeEvent(
                        type="agent_status",
                        message=assistant_text[:500],
                        payload={"source": "agent_message", "full_content": assistant_text},
                    ))
                await state.queue.put(RuntimeEvent(type="completed", message="Turn completed"))
            return

        if method == "turn/plan/updated":
            explanation = params.get("explanation")
            plan = params.get("plan", [])
            message = explanation or f"Plan updated with {len(plan)} step(s)"
            await state.queue.put(
                RuntimeEvent(type="plan_updated", message=message, payload={"plan": plan, "explanation": explanation})
            )
            return

        if method == "turn/diff/updated":
            diff = _coerce_diff_text(params.get("diff"))
            if not diff:
                diff = _coerce_diff_text(params)
            if not diff:
                extracted = _extract_diff_payload(params)
                if extracted is not None:
                    state.latest_diff = extracted
                    await state.queue.put(
                        RuntimeEvent(
                            type="diff_generated",
                            message=state.latest_diff.summary,
                            payload=state.latest_diff.model_dump(),
                        )
                    )
                    for file_path in state.latest_diff.files_changed:
                        await state.queue.put(RuntimeEvent(type="file_changed", message=file_path, payload={"file": file_path}))
                return
            state.latest_diff = _build_diff_payload(diff)
            await state.queue.put(
                RuntimeEvent(
                    type="diff_generated",
                    message=state.latest_diff.summary,
                    payload=state.latest_diff.model_dump(),
                )
            )
            for file_path in state.latest_diff.files_changed:
                await state.queue.put(RuntimeEvent(type="file_changed", message=file_path, payload={"file": file_path}))
            return

        if method == "error":
            await state.queue.put(RuntimeEvent(type="failed", message=params.get("message", "Codex App Server error")))
            return

        if method == "serverRequest/resolved":
            request_id = params.get("requestId")
            state.pending_requests.pop(request_id, None)
            await state.queue.put(
                RuntimeEvent(
                    type="agent_status",
                    message="Pending interaction resolved",
                    payload={"request_id": request_id, "cleanup_pending_snapshot": True},
                )
            )
            return

        if method == "item/agentMessage/delta":
            delta = params.get("delta", "")
            if delta:
                state.agent_message_buffer += delta
            return

        if method == "item/completed":
            item = params.get("item", {})
            item_type = item.get("type", "")
            item_role = item.get("role", "")
            is_assistant = (
                item_type in {"message", "assistantMessage", "assistant_message", "agentMessage"}
                or item_role == "assistant"
            )
            if is_assistant:
                text = _extract_assistant_text_from_items([item])
                if not text:
                    text = state.agent_message_buffer
                state.agent_message_buffer = ""
                if text:
                    await state.queue.put(RuntimeEvent(
                        type="agent_status",
                        message=text[:500],
                        payload={"source": "agent_message", "full_content": text},
                    ))
            else:
                state.agent_message_buffer = ""
            return

        if method == "item/commandExecution/outputDelta":
            delta = params.get("delta", "")
            if delta:
                await state.queue.put(RuntimeEvent(type="command_executed", message=delta[:200], payload={"source": "outputDelta"}))
            return

        if method == "item/plan/delta":
            delta = params.get("delta", "")
            if delta:
                await state.queue.put(
                    RuntimeEvent(
                        type="plan_delta",
                        message=delta[:200],
                        payload={"delta": delta, "item_id": params.get("itemId"), "turn_id": params.get("turnId")},
                    )
                )
            return

        if method.startswith("codex/event/"):
            await self._handle_legacy_event(state, method, params)

    async def _handle_legacy_event(self, state: SessionState, method: str, params: dict[str, Any]) -> None:
        event = params.get("msg", {})
        event_type = event.get("type")
        if event_type == "exec_command_begin":
            command = event.get("command") or event.get("parsed_cmd") or "Command started"
            await state.queue.put(RuntimeEvent(type="command_executed", message=str(command)))
        elif event_type == "exec_command_end":
            message = event.get("stdout") or event.get("stderr") or "Command finished"
            if "test" in str(event.get("parsed_cmd") or event.get("command") or "").lower():
                await state.queue.put(RuntimeEvent(type="test_result", message=str(message)[:200]))
            else:
                await state.queue.put(RuntimeEvent(type="command_executed", message=str(message)[:200]))
        elif event_type == "task_started":
            collaboration_mode = event.get("collaboration_mode_kind")
            if state.start_request and state.start_request.execution_mode == "plan" and collaboration_mode not in {None, "plan"}:
                await state.queue.put(
                    RuntimeEvent(
                        type="failed",
                        message=f"Codex runtime started in '{collaboration_mode}' mode instead of 'plan'",
                        payload={"reported_mode": collaboration_mode},
                    )
                )
            else:
                await state.queue.put(RuntimeEvent(type="agent_status", message="Task started"))
        elif event_type == "turn_diff":
            diff = event.get("unified_diff", "")
            if diff:
                state.latest_diff = _build_diff_payload(diff)
                await state.queue.put(
                    RuntimeEvent(
                        type="diff_generated",
                        message=state.latest_diff.summary,
                        payload=state.latest_diff.model_dump(),
                    )
                )
        elif event_type == "agent_message":
            message = event.get("message")
            if message:
                await state.queue.put(RuntimeEvent(
                    type="agent_status",
                    message=str(message)[:500],
                    payload={"source": "agent_message", "full_content": str(message)},
                ))

    def _approval_result_for(self, pending: PendingRequest) -> dict[str, Any]:
        if pending.method == "item/commandExecution/requestApproval":
            return {"decision": "accept"}
        if pending.method == "item/fileChange/requestApproval":
            return {"decision": "accept"}
        raise RuntimeError(f"Unsupported approval request: {pending.method}")

    def _find_pending_request(self, state: SessionState, request_id: int | str) -> PendingRequest | None:
        pending = state.pending_requests.get(request_id)
        if pending is not None:
            return pending
        request_id_str = str(request_id)
        for candidate in state.pending_requests.values():
            if str(candidate.request_id) == request_id_str:
                return candidate
        return None

    def _require_session(self, session_id: str) -> SessionState:
        state = self._sessions.get(session_id)
        if state is None:
            raise RuntimeError("Unknown Codex App Server session")
        return state
