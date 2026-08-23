import asyncio
import os

os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.claude_adapter import KNOWN_MODELS, ClaudeCliAdapter, _ClaudeSession, _parse_usage_output


def _session(execution_mode: str = "execute") -> _ClaudeSession:
    return _ClaudeSession(working_directory="/tmp", default_branch="main", model=None, execution_mode=execution_mode)


def test_list_models_returns_the_known_alias_catalog():
    adapter = ClaudeCliAdapter()
    result = asyncio.run(adapter.list_models())
    assert result == KNOWN_MODELS
    # Aliases the CLI itself documents, not full model IDs -- verified live
    # that each resolves rather than guessed.
    assert "sonnet" in result
    assert "opus" in result


def test_list_collaboration_modes_advertises_real_plan_support():
    # Unlike Grok/Antigravity, Claude's plan mode is a real CLI feature
    # (--permission-mode plan), confirmed live to leave files untouched.
    adapter = ClaudeCliAdapter()
    assert asyncio.run(adapter.list_collaboration_modes()) == ["plan"]


def test_handle_stream_event_assistant_text_emits_agent_status():
    adapter = ClaudeCliAdapter()
    session = _session()

    item = {
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": "Hello from Claude"}]},
    }
    result = asyncio.run(adapter._handle_stream_event(session, item))

    assert result is None  # not a terminal `result` event
    event = session.queue.get_nowait()
    assert event.type == "agent_status"
    assert event.message == "Hello from Claude"


def test_handle_stream_event_assistant_tool_use_emits_command_executed():
    adapter = ClaudeCliAdapter()
    session = _session()

    item = {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "x.py"}}]},
    }
    asyncio.run(adapter._handle_stream_event(session, item))

    event = session.queue.get_nowait()
    assert event.type == "command_executed"
    assert "Edit" in event.message
    assert event.payload == {"file_path": "x.py"}


def test_handle_stream_event_ignores_thinking_blocks():
    adapter = ClaudeCliAdapter()
    session = _session()

    item = {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "internal reasoning"}]}}
    asyncio.run(adapter._handle_stream_event(session, item))

    assert session.queue.empty()


def test_handle_stream_event_init_captures_session_id():
    adapter = ClaudeCliAdapter()
    session = _session()
    assert session.claude_session_id is None

    asyncio.run(
        adapter._handle_stream_event(session, {"type": "system", "subtype": "init", "session_id": "abc-123"})
    )

    assert session.claude_session_id == "abc-123"


def test_handle_stream_event_result_returns_final_text_and_error_flag():
    adapter = ClaudeCliAdapter()
    session = _session()

    result = asyncio.run(
        adapter._handle_stream_event(
            session, {"type": "result", "result": "All done.", "is_error": False, "session_id": "sess-1"}
        )
    )

    assert result == ("All done.", False)
    assert session.claude_session_id == "sess-1"


def test_handle_stream_event_result_reports_errors():
    adapter = ClaudeCliAdapter()
    session = _session()

    # Regression: hit for real against the live CLI with an invalid --model
    # -- stderr was completely empty, but the `result` event carried a
    # clear diagnosis ("There's an issue with the selected model...") with
    # is_error=true and exit code 1. This is what lets _run_turn surface
    # that reason instead of falling back to an empty stderr dump.
    result = asyncio.run(
        adapter._handle_stream_event(
            session,
            {
                "type": "result",
                "result": "There's an issue with the selected model (bogus). It may not exist.",
                "is_error": True,
                "session_id": "sess-2",
            },
        )
    )

    assert result == ("There's an issue with the selected model (bogus). It may not exist.", True)


def test_require_session_raises_for_unknown_session():
    adapter = ClaudeCliAdapter()
    try:
        adapter._require_session("does-not-exist")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "Unknown Claude session" in str(exc)


def test_approve_and_respond_are_unsupported_in_headless_mode():
    adapter = ClaudeCliAdapter()
    adapter._sessions["s1"] = _session()

    for coro in (adapter.approve_task("s1"), adapter.respond_task("s1", 1, {})):
        try:
            asyncio.run(coro)
            assert False, "expected RuntimeError"
        except RuntimeError:
            pass


def test_run_turn_uses_a_generous_readline_limit():
    # Same regression as Grok/Antigravity: a single NDJSON line can carry a
    # full tool_call's before/after file content, past asyncio's 64KiB
    # readline() default. This doesn't spawn a real process; it just
    # confirms the source actually passes a raised limit.
    import inspect

    from app import claude_adapter

    # The actual subprocess spawn moved into _spawn_and_stream (shared by
    # the normal path and the --session-id "already in use" --resume retry).
    source = inspect.getsource(claude_adapter.ClaudeCliAdapter._spawn_and_stream)
    assert "limit=" in source
    assert "65536" not in source, "must not be left at asyncio's default"


def test_parse_usage_output_extracts_session_and_week_percentages():
    # Real output captured from `claude -p "/usage"` -- confirmed live this
    # costs nothing (total_cost_usd: 0, num_turns: 0), so it's safe to call
    # on a schedule.
    text = (
        "You are currently using your subscription to power your Claude Code usage\n\n"
        "Current session: 37% used · resets Aug 21 at 11:59am (Asia/Seoul)\n"
        "Current week (all models): 51% used · resets Aug 23 at 11:59am (Asia/Seoul)\n\n"
        "What's contributing to your limits usage?\n"
    )

    usage = _parse_usage_output(text)

    assert usage is not None
    assert usage.session is not None
    assert usage.session.percent_used == 37
    assert usage.session.resets_label == "Aug 21 at 11:59am (Asia/Seoul)"
    assert usage.week is not None
    assert usage.week.percent_used == 51
    assert usage.week.resets_label == "Aug 23 at 11:59am (Asia/Seoul)"


def test_parse_usage_output_handles_missing_reset_label():
    usage = _parse_usage_output("Current session: 10% used\n")
    assert usage is not None
    assert usage.session is not None
    assert usage.session.percent_used == 10
    assert usage.session.resets_label is None
    assert usage.week is None


def test_parse_usage_output_returns_none_for_unrecognized_text():
    assert _parse_usage_output("some unrelated CLI output") is None


def test_run_turn_maps_plan_execution_mode_to_the_real_plan_permission_mode():
    # Confirmed live: --permission-mode plan genuinely leaves files
    # untouched, unlike Grok/Antigravity where "plan" has no CLI-level
    # effect. Guard the mapping itself (not just that *a* limit is passed).
    import inspect

    from app import claude_adapter

    source = inspect.getsource(claude_adapter.ClaudeCliAdapter._run_turn)
    assert '"plan" if session.execution_mode == "plan" else "bypassPermissions"' in source


def test_followup_task_switches_the_model_for_subsequent_turns():
    # Each turn is its own CLI spawn (--resume keeps the same Claude
    # session/history going; --model is a separate, independent flag), so
    # switching the model doesn't require a new session -- sticky from
    # here on, not just for this one message.
    async def run() -> None:
        adapter = ClaudeCliAdapter()
        session = _session()
        adapter._sessions["s1"] = session

        result = await adapter.followup_task("s1", "next message", model="claude-opus-5")

        assert session.model == "claude-opus-5"
        assert result.effective_model == "claude-opus-5"

        # No override -> keeps using it.
        result2 = await adapter.followup_task("s1", "another message")
        assert result2.effective_model == "claude-opus-5"

    asyncio.run(run())


def test_run_turn_retries_with_resume_when_session_id_is_already_in_use():
    # Hit for real live: an API process restart wipes our own in-memory
    # session bookkeeping, but the Claude CLI's own session store (on disk,
    # independent of us) still remembers the id -- so re-using --session-id
    # for what we think is a "fresh" start gets rejected. --resume is what
    # actually continues it.
    async def run() -> None:
        adapter = ClaudeCliAdapter()
        session = _session()
        calls: list[list[str]] = []

        async def fake_spawn_and_stream(session_arg, args):
            calls.append(args)
            if "--session-id" in args:
                return "", False, b"Error: Session ID task-1 is already in use.\n", 1
            return "resumed successfully", False, b"", 0

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


def test_run_turn_does_not_retry_a_different_failure():
    # Only the specific "already in use" collision should trigger a retry
    # -- any other failure must surface normally, not silently retry.
    async def run() -> None:
        adapter = ClaudeCliAdapter()
        session = _session()
        calls: list[list[str]] = []

        async def fake_spawn_and_stream(session_arg, args):
            calls.append(args)
            return "", True, b"Some unrelated error\n", 1

        adapter._spawn_and_stream = fake_spawn_and_stream

        await adapter._run_turn(session, "hello", new_session_id="task-1")

        assert len(calls) == 1

        events = []
        while not session.queue.empty():
            events.append(session.queue.get_nowait())
        types = [e.type for e in events]
        assert "failed" in types

    asyncio.run(run())
