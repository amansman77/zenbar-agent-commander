"""Stale session error classification across Codex App Server and CLI engines.

Centralizes the heuristic that recognizes when a runtime session is dead or
missing and needs to be cleared and restarted, rather than retried.
"""

from __future__ import annotations


def is_stale_session_error(exc: Exception) -> bool:
    """Check if an exception indicates that a runtime session no longer exists.

    Two different shapes mean the same thing -- "this session doesn't
    exist anymore, clear it and start fresh" -- but come from different
    layers. Every adapter's own local _require_session raises
    "Unknown <X> session" when OUR process has no record of the session
    at all (e.g. right after an API restart, before Codex's App Server
    reconnects). Codex specifically can *also* still have a locally-valid
    session record while the actual remote App Server process has quietly
    dropped that thread (evicted, or hiccuped without a full crash) --
    that surfaces as the App Server's own RPC error message, verbatim,
    which is "thread not found: <id>", not "Unknown ... session". Missing
    this second shape meant retry_task re-raised instead of self-healing
    (a real 409 a user hit), and _consume_events' background loop treated
    it as a transient stream hiccup and reconnected forever instead of
    ending the loop -- which is why a task already marked "failed" kept
    producing "still running" heartbeat events indefinitely. Reproduced
    live via the exception logging added to safe_runtime_error_detail.
    """
    exc_msg = str(exc)
    if (exc_msg.startswith("Unknown ") and exc_msg.endswith(" session")) or "Task has no runtime session" in exc_msg:
        return True
    return exc_msg.startswith("thread not found:")
