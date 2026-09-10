from app.stale_session import is_stale_session_error


def test_is_stale_session_error_matches_unknown_session():
    assert is_stale_session_error(RuntimeError("Unknown codex session"))
    assert is_stale_session_error(RuntimeError("Unknown claude session"))
    assert is_stale_session_error(RuntimeError("Unknown grok session"))
    assert is_stale_session_error(RuntimeError("Unknown antigravity session"))


def test_is_stale_session_error_matches_thread_not_found():
    assert is_stale_session_error(RuntimeError("thread not found: th_12345"))


def test_is_stale_session_error_matches_no_runtime_session():
    assert is_stale_session_error(RuntimeError("Task has no runtime session"))


def test_is_stale_session_error_ignores_other_errors():
    assert not is_stale_session_error(RuntimeError("Connection refused"))
    assert not is_stale_session_error(ValueError("Invalid model"))
