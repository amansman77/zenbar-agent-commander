from __future__ import annotations

import asyncio
import json
import os
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from itertools import count
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from .schemas import RuntimeEvent, RuntimeSession, RuntimeStartRequest, TaskDiff


def _extract_files_from_diff(diff: str) -> list[str]:
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                files.append(parts[3].removeprefix("b/"))
        elif line.startswith("+++ b/"):
            files.append(line.removeprefix("+++ b/"))
    return list(dict.fromkeys(files))


def _build_diff_payload(diff: str) -> TaskDiff:
    files = _extract_files_from_diff(diff)
    summary = f"Updated {len(files)} file(s) in the Task Workspace." if files else "Diff updated in Codex App Server."
    return TaskDiff(files_changed=files, summary=summary, raw_diff=diff)


def _prompt_with_workspace(request: RuntimeStartRequest) -> str:
    operation = (
        "Produce an implementation plan without modifying files or accepting final code changes."
        if request.execution_mode == "plan"
        else "Operate inside the current repository working directory."
    )
    return (
        f"Task title: {request.title}\n"
        f"Task workspace: {request.workspace_ref}\n"
        f"Task working directory: {request.working_directory}\n"
        f"Default branch: {request.default_branch}\n\n"
        f"{request.prompt}\n\n"
        f"{operation} "
        "Human approval is required before the task result is accepted as final."
    )


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


class RuntimeAdapter(ABC):
    stream_in_background = True

    @abstractmethod
    async def list_collaboration_modes(self) -> list[str] | None:
        raise NotImplementedError

    @abstractmethod
    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        raise NotImplementedError

    @abstractmethod
    async def stop_task(self, session_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def approve_task(self, session_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        raise NotImplementedError

    @abstractmethod
    async def retry_task(self, session_id: str) -> RuntimeSession:
        raise NotImplementedError

    @abstractmethod
    async def get_diff(self, session_id: str) -> TaskDiff:
        raise NotImplementedError

    @abstractmethod
    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        raise NotImplementedError


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

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        await self._ensure_connection()
        thread = await self._rpc(
            "thread/start",
            {
                "cwd": request.working_directory,
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "personality": "pragmatic",
            },
        )
        thread_id = thread["thread"]["id"]
        state = SessionState(thread_id=thread_id, start_request=request)
        self._sessions[thread_id] = state
        turn = await self._rpc("turn/start", self._build_turn_start_params(thread_id, request, thread.get("model")))
        state.current_turn_id = turn["turn"]["id"]
        await state.queue.put(RuntimeEvent(type="agent_status", message="Codex App Server turn started"))
        return RuntimeSession(session_id=thread_id)

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
        return RuntimeSession(session_id=session_id)

    def _build_turn_start_params(
        self,
        thread_id: str,
        request: RuntimeStartRequest,
        model: str | None = None,
    ) -> dict[str, Any]:
        return {
            "threadId": thread_id,
            "input": [{"type": "text", "text": _prompt_with_workspace(request), "text_elements": []}],
            "collaborationMode": (
                {
                    "mode": "plan",
                    "settings": {
                        "model": model,
                        "developer_instructions": None,
                        "reasoning_effort": "medium",
                    },
                }
                if request.execution_mode == "plan"
                else None
            ),
            "sandboxPolicy": {
                "type": "workspaceWrite",
                "writableRoots": [request.working_directory],
                "readOnlyAccess": {"type": "fullAccess"},
                "networkAccess": False,
                "excludeTmpdirEnvVar": False,
                "excludeSlashTmp": False,
            },
            "approvalPolicy": "on-request",
            "personality": "pragmatic",
        }

    async def get_diff(self, session_id: str) -> TaskDiff:
        return self._require_session(session_id).latest_diff

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        state = self._require_session(session_id)
        while True:
            yield await state.queue.get()

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
            diff = params.get("diff", "")
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
                await state.queue.put(RuntimeEvent(type="agent_status", message=str(message)[:200]))

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


class MockRuntimeAdapter(RuntimeAdapter):
    stream_in_background = False

    def __init__(self) -> None:
        self._events: dict[str, list[RuntimeEvent]] = {}
        self._diffs: dict[str, TaskDiff] = {}
        self._requests: dict[str, RuntimeStartRequest] = {}

    async def list_collaboration_modes(self) -> list[str] | None:
        return ["default", "plan"]

    async def start_task(self, request: RuntimeStartRequest) -> RuntimeSession:
        session_id = f"mock-{request.task_id}"
        self._requests[session_id] = request
        if request.execution_mode == "plan":
            self._events[session_id] = [
                RuntimeEvent(type="agent_status", message="Analyzing repository in plan mode"),
                RuntimeEvent(
                    type="plan_updated",
                    message="Plan updated with 2 step(s)",
                    payload={
                        "explanation": "Produce a safe implementation sequence.",
                        "plan": [
                            {"step": "Inspect sitemap generation", "status": "in_progress"},
                            {"step": "Add regression test coverage", "status": "pending"},
                        ],
                    },
                ),
                RuntimeEvent(type="plan_delta", message="Inspect sitemap generation"),
                RuntimeEvent(type="completed", message="Plan completed"),
            ]
            self._diffs[session_id] = TaskDiff()
        else:
            self._events[session_id] = [
                RuntimeEvent(type="agent_status", message="Analyzing repository"),
                RuntimeEvent(type="file_changed", message="app/sitemap.ts", payload={"file": "app/sitemap.ts"}),
                RuntimeEvent(type="diff_generated", message="Patch ready", payload={"files_changed": ["app/sitemap.ts"]}),
                RuntimeEvent(
                    type="result_approval_requested",
                    message="Waiting for result approval",
                    payload={"request_id": "mock-approval", "method": "item/fileChange/requestApproval"},
                ),
            ]
            self._diffs[session_id] = TaskDiff(
                files_changed=["app/sitemap.ts"],
                summary="Added canonical tag fallback",
                raw_diff="diff --git a/app/sitemap.ts b/app/sitemap.ts\n+ canonical fallback",
            )
        return RuntimeSession(session_id=session_id)

    async def stop_task(self, session_id: str) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).append(RuntimeEvent(type="stopped", message="Task stopped"))

    async def approve_task(self, session_id: str) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).extend(
            [
                RuntimeEvent(
                    type="result_approval_granted",
                    message="Result approval granted",
                    payload={"request_id": "mock-approval"},
                ),
                RuntimeEvent(type="agent_status", message="Running tests"),
                RuntimeEvent(type="test_result", message="All tests passed"),
                RuntimeEvent(type="completed", message="Accepted result completed"),
            ]
        )

    async def respond_task(self, session_id: str, request_id: int | str, answers: dict[str, list[str]]) -> None:
        if session_id not in self._events:
            raise RuntimeError("Unknown Codex App Server session")
        self._events.setdefault(session_id, []).extend(
            [
                RuntimeEvent(
                    type="user_input_submitted",
                    message="User input submitted",
                    payload={"request_id": request_id, "answers": answers},
                ),
                RuntimeEvent(type="agent_status", message="Continuing after user input"),
            ]
        )

    async def retry_task(self, session_id: str) -> RuntimeSession:
        request = self._requests.get(session_id)
        if request is None:
            task_id = session_id.replace("mock-", "")
            request = RuntimeStartRequest(
                task_id=task_id,
                title="retry",
                prompt="retry",
                repo_path="/srv/repos/demo",
                working_directory="/srv/repos/demo",
                default_branch="main",
                execution_mode="execute",
                workspace_type="branch",
                workspace_ref=f"task/retry-{task_id[:4]}",
            )
        return await self.start_task(request)

    async def get_diff(self, session_id: str) -> TaskDiff:
        if session_id not in self._diffs:
            raise RuntimeError("Unknown Codex App Server session")
        return self._diffs[session_id]

    async def subscribe_events(self, session_id: str) -> AsyncIterator[RuntimeEvent]:
        events = self._events.get(session_id, [])
        while events:
            event = events.pop(0)
            await asyncio.sleep(0.01)
            yield event


def create_runtime_adapter() -> RuntimeAdapter:
    mode = os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws")
    if mode == "mock":
        return MockRuntimeAdapter()
    return AppServerWebSocketAdapter(os.getenv("ZENBAR_APP_SERVER_WS_URL", "ws://127.0.0.1:8765"))
