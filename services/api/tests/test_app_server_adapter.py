"""Server requests the App Server sends us mid-turn, and how we answer them.

An unanswered server request wedges the whole turn: the App Server waits
forever, the task keeps reporting itself as running, and nothing in the UI
says a person is being asked anything.
"""

import asyncio

from app.runtime.app_server import AppServerWebSocketAdapter, PendingRequest, SessionState

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
