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


def test_run_turn_uses_a_generous_readline_limit():
    # Regression: hit for real against the live CLI -- a turn touching a
    # large file failed with asyncio.LimitOverrunError ("Separator is
    # found, but chunk is longer than limit") because a single NDJSON line
    # can carry a full tool_call_update (e.g. a whole file's before/after
    # content), comfortably past asyncio's 64KiB readline() default. This
    # doesn't spawn a real process; it just confirms the source actually
    # passes a raised limit to create_subprocess_exec, since the failure
    # mode only reproduces against a real large file over a real subprocess
    # (verified manually, not worth a slow/flaky test double for CI).
    import inspect

    from app import grok_adapter

    # The actual subprocess spawn moved into _spawn_and_stream (shared by
    # the normal path and the --session-id "already in use" --resume retry).
    source = inspect.getsource(grok_adapter.GrokCliAdapter._spawn_and_stream)
    assert "limit=" in source
    assert "65536" not in source, "must not be left at asyncio's default"


def test_followup_task_switches_the_model_for_subsequent_turns():
    # Each turn is its own CLI spawn (--resume keeps the same Grok
    # session/history going; --model is a separate, independent flag), so
    # switching the model doesn't require a new session -- sticky from
    # here on, not just for this one message.
    async def run() -> None:
        adapter = GrokCliAdapter()
        session = _session()
        adapter._sessions["s1"] = session

        result = await adapter.followup_task("s1", "next message", model="grok-4-fast")

        assert session.model == "grok-4-fast"
        assert result.effective_model == "grok-4-fast"

        # No override -> keeps using it.
        result2 = await adapter.followup_task("s1", "another message")
        assert result2.effective_model == "grok-4-fast"

    asyncio.run(run())


def test_run_turn_retries_with_resume_when_session_id_is_already_in_use():
    # Mirrors the same collision confirmed live on the Claude adapter: an
    # API process restart wipes our own in-memory session bookkeeping, but
    # the Grok CLI's own session store (on disk, independent of us) still
    # remembers the id -- so re-using --session-id for what we think is a
    # "fresh" start gets rejected. --resume is what actually continues it.
    async def run() -> None:
        adapter = GrokCliAdapter()
        session = _session()
        calls: list[list[str]] = []

        async def fake_spawn_and_stream(session_arg, args):
            calls.append(args)
            if "--session-id" in args:
                return "", b"Error: Session ID task-1 is already in use.\n", 1
            return "resumed successfully", b"", 0

        adapter._spawn_and_stream = fake_spawn_and_stream

        await adapter._run_turn(session, "hello", new_session_id="task-1")

        assert len(calls) == 2
        assert "--session-id" in calls[0] and "task-1" in calls[0]
        assert "--resume" in calls[1] and "task-1" in calls[1]
        assert "--session-id" not in calls[1]

        events = []
        while not session.queue.empty():
            events.append(session.queue.get_nowait())
        types = [e.type for e in events]
        assert "completed" in types
        assert "failed" not in types

    asyncio.run(run())
