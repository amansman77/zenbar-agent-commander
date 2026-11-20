"""Server requests the App Server sends us mid-turn, and how we answer them.

An unanswered server request wedges the whole turn: the App Server waits
forever, the task keeps reporting itself as running, and nothing in the UI
says a person is being asked anything.
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.runtime import RuntimeSessionReattachError
from app.runtime.app_server import AppServerWebSocketAdapter, PendingRequest, SessionState
from app.schemas import RuntimeStartRequest

ELICITATION_PARAMS = {
    "threadId": "thread-1",
    "turnId": "turn-1",
    "serverName": "cua_repl",
    "mode": "form",
    "message": 'Allow Computer Use to use "Arc"?',
    "requestedSchema": {"type": "object", "properties": {}},
    "_meta": {
        "connector_name": "Computer Use",
        "codex_approval_kind": "mcp_tool_call",
        "riskLevel": "high",
        "tool_name": "get_app_state",
    },
}


def _adapter_with_session() -> tuple[AppServerWebSocketAdapter, SessionState]:
    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    state = SessionState(thread_id="thread-1")
    adapter._sessions["thread-1"] = state
    return adapter, state


def test_mcp_elicitation_becomes_a_pending_approval_not_an_unhandled_log():
    adapter, state = _adapter_with_session()

    asyncio.run(
        adapter._handle_server_request(
            {"id": 7, "method": "mcpServer/elicitation/request", "params": ELICITATION_PARAMS}
        )
    )

    pending = state.pending_requests[7]
    assert pending.method == "mcpServer/elicitation/request"
    assert pending.interaction_type == "result_approval"

    event = state.queue.get_nowait()
    assert event.type == "result_approval_requested"
    # The prompt itself, so the dashboard shows what is being approved.
    assert event.message == 'Allow Computer Use to use "Arc"?'


def test_elicitation_is_answered_with_an_action_not_a_decision():
    # McpServerElicitationRequestResponse takes `action`; the two
    # requestApproval methods take `decision`. Sending the wrong key leaves
    # the turn blocked exactly as if nothing had been sent.
    adapter, _ = _adapter_with_session()
    pending = PendingRequest(
        request_id=7,
        method="mcpServer/elicitation/request",
        params=ELICITATION_PARAMS,
        interaction_type="result_approval",
    )

    assert adapter._approval_result_for(pending) == {"action": "accept", "content": None}


def _resume_request(tmp_path) -> RuntimeStartRequest:
    return RuntimeStartRequest(
        task_id="task-1", title="Test task", prompt="", model="default",
        repo_path=str(tmp_path), working_directory=str(tmp_path), default_branch="main",
        workspace_type="branch", workspace_ref="task/test",
    )


def test_reattach_subscribes_once_and_keeps_replayed_approval(monkeypatch, tmp_path):
    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    request = _resume_request(tmp_path)

    async def rpc(method, params):
        assert method == "thread/resume"
        assert params == {"threadId": "thread-1", "cwd": str(tmp_path)}
        assert not adapter.knows_session("thread-1")
        await adapter._handle_server_request(
            {"id": 7, "method": "mcpServer/elicitation/request", "params": ELICITATION_PARAMS}
        )
        return {
            "thread": {
                "id": "thread-1",
                "status": {"type": "active", "activeFlags": ["waitingOnApproval"]},
                "turns": [{"id": "turn-1", "status": "inProgress"}],
            }
        }

    resume = AsyncMock(side_effect=rpc)
    send = AsyncMock()
    monkeypatch.setattr(adapter, "_rpc", resume)
    monkeypatch.setattr(adapter, "_send_json", send)

    async def scenario():
        assert await asyncio.gather(
            adapter.reattach_session("thread-1", request),
            adapter.reattach_session("thread-1", request),
        ) == [True, True]
        assert adapter.has_running_turn("thread-1")
        events = adapter.subscribe_events("thread-1")
        assert (await anext(events)).type == "result_approval_requested"
        await adapter.approve_task("thread-1")
        assert (await anext(events)).type == "result_approval_granted"
        await events.aclose()

    asyncio.run(scenario())
    resume.assert_awaited_once()
    send.assert_awaited_once_with({"jsonrpc": "2.0", "id": 7, "result": {"action": "accept", "content": None}})


def test_reattached_idle_thread_retries_latest_request_in_same_thread(monkeypatch, tmp_path):
    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    rpc = AsyncMock(side_effect=[
        {"thread": {"id": "thread-1", "status": {"type": "idle"}, "turns": [{"id": "old", "status": "completed"}]}},
        {"turn": {"id": "new"}},
    ])
    monkeypatch.setattr(adapter, "_rpc", rpc)

    async def scenario():
        assert await adapter.reattach_session("thread-1", _resume_request(tmp_path))
        assert not adapter.has_running_turn("thread-1")
        assert (await adapter.retry_task("thread-1")).session_id == "thread-1"

    asyncio.run(scenario())
    method, params = rpc.await_args.args
    assert method == "turn/start"
    assert params["threadId"] == "thread-1"
    assert params["input"][0]["text"].endswith("Please continue with my most recent request.")


def test_only_missing_transcript_is_treated_as_stale(monkeypatch, tmp_path):
    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    rpc = AsyncMock(side_effect=[
        ConnectionRefusedError("App Server offline"),
        RuntimeError("no rollout found for thread id thread-1"),
    ])
    monkeypatch.setattr(adapter, "_rpc", rpc)

    async def scenario():
        request = _resume_request(tmp_path)
        with pytest.raises(RuntimeSessionReattachError, match="App Server offline"):
            await adapter.reattach_session("thread-1", request)
        assert not adapter.knows_session("thread-1")
        assert not await adapter.reattach_session("thread-1", request)
        assert not adapter.knows_session("thread-1")

    asyncio.run(scenario())
