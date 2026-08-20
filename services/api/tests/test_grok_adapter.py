import asyncio
import os

os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.grok_adapter import GrokCliAdapter, _GrokSession, _parse_models_output


def test_parse_models_output_extracts_ids_from_prose():
    text = (
        "You are logged in with grok.com.\n"
        "\n"
        "Default model: grok-4.6\n"
        "\n"
        "Available models:\n"
        "  * grok-4.6 (default)\n"
        "  - grok-4-fast\n"
    )
    assert _parse_models_output(text) == ["grok-4.6", "grok-4-fast"]


def test_parse_models_output_empty_text_returns_empty_list():
    assert _parse_models_output("") == []


def _session() -> _GrokSession:
    return _GrokSession(working_directory="/tmp", default_branch="main", model=None)


def test_handle_stream_event_accumulates_text_deltas_and_ignores_thoughts():
    adapter = GrokCliAdapter()
    session = _session()

    async def run():
        buf = ""
        buf = await adapter._handle_stream_event(session, {"type": "thought", "data": "internal reasoning"}, buf)
        buf = await adapter._handle_stream_event(session, {"type": "text", "data": "Hello"}, buf)
        buf = await adapter._handle_stream_event(session, {"type": "text", "data": ", world"}, buf)
        return buf

    result = asyncio.run(run())
    assert result == "Hello, world"
    # Each text delta pushes the running buffer as an agent_status event;
    # the thought delta must not have pushed anything.
    events = []
    while not session.queue.empty():
        events.append(session.queue.get_nowait())
    assert [e.message for e in events] == ["Hello", "Hello, world"]


def test_handle_stream_event_tool_call_emits_command_executed():
    adapter = GrokCliAdapter()
    session = _session()

    asyncio.run(
        adapter._handle_stream_event(
            session,
            {"type": "tool_call", "title": "write", "toolName": "write", "rawInput": {"file_path": "x.txt"}},
            "",
        )
    )
    event = session.queue.get_nowait()
    assert event.type == "command_executed"
    assert "write" in event.message


def test_handle_stream_event_end_captures_session_id_for_resume():
    adapter = GrokCliAdapter()
    session = _session()
    assert session.grok_session_id is None

    asyncio.run(adapter._handle_stream_event(session, {"type": "end", "sessionId": "abc-123"}, ""))

    assert session.grok_session_id == "abc-123"


def test_require_session_raises_for_unknown_session():
    adapter = GrokCliAdapter()
    try:
        adapter._require_session("does-not-exist")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "Unknown Grok session" in str(exc)


def test_approve_and_respond_are_unsupported_in_headless_mode():
    adapter = GrokCliAdapter()
    adapter._sessions["s1"] = _session()

    for coro in (adapter.approve_task("s1"), adapter.respond_task("s1", 1, {})):
        try:
            asyncio.run(coro)
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass
