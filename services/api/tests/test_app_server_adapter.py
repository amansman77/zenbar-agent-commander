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


def test_inline_images_are_sent_as_image_inputs_on_initial_and_followup_turns():
    from unittest.mock import AsyncMock

    from app.schemas import RuntimeStartRequest

    adapter, state = _adapter_with_session()
    image = "data:image/png;base64,aGVsbG8="
    message = f"확인해줘\n\n![붙여넣은 이미지]({image})"
    request = RuntimeStartRequest(
        task_id="task-1", prompt=message, title="Image", model="default",
        reasoning_effort="medium", execution_mode="execute", repo_path="/tmp/repo", working_directory="/tmp/workspace",
        workspace_type="worktree", workspace_ref="task/test",
        default_branch="main",
    )
    state.start_request = request
    params = adapter._build_turn_start_params("thread-1", request)
    assert params["input"][-1] == {"type": "image", "url": image}
    assert image not in params["input"][0]["text"]

    adapter._rpc = AsyncMock(return_value={"turn": {"id": "turn-2"}})
    asyncio.run(adapter.followup_task("thread-1", message))
    sent = adapter._rpc.call_args.args[1]["input"]
    assert sent == [
        {"type": "text", "text": "확인해줘\n\n", "text_elements": []},
        {"type": "image", "url": image},
    ]


def test_image_only_and_text_only_inputs():
    from app.runtime.app_server import _message_inputs

    image = "data:image/webp;base64,aGVsbG8="
    assert _message_inputs(f"![이미지]({image})") == [{"type": "image", "url": image}]
    assert _message_inputs("plain text") == [{"type": "text", "text": "plain text", "text_elements": []}]
    assert _message_inputs("![unsafe](data:image/svg+xml;base64,PHN2Zz4=)")[0]["type"] == "text"


def test_conversation_preview_omits_inline_image_data():
    from app.message_images import message_preview

    assert message_preview("확인\n![이미지](data:image/png;base64,aGVsbG8=)") == "확인\n[첨부 이미지]"
