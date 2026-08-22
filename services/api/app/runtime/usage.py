"""Turning the runtime's rate-limit windows into account usage info.

The App Server reports two unlabeled windows; which is the session window and
which is the weekly one has to be inferred from their duration.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..schemas import RuntimeUsageWindow

_SESSION_WINDOW_MAX_MINUTES = 360


_WEEK_WINDOW_MIN_MINUTES = 10000


def _rate_limit_window_to_usage_window(window: dict[str, Any] | None) -> RuntimeUsageWindow | None:
    if not isinstance(window, dict):
        return None
    used_percent = window.get("usedPercent")
    if not isinstance(used_percent, (int, float)):
        return None
    resets_label: str | None = None
    resets_at_iso: str | None = None
    resets_at = window.get("resetsAt")
    if isinstance(resets_at, (int, float)):
        try:
            resets_dt = datetime.fromtimestamp(resets_at).astimezone()
            resets_label = resets_dt.strftime("%b %d, %H:%M %Z")
            resets_at_iso = resets_dt.isoformat()
        except (OverflowError, OSError, ValueError):
            resets_label = None
    return RuntimeUsageWindow(percent_used=round(used_percent), resets_label=resets_label, resets_at=resets_at_iso)


def _classify_rate_limit_windows(
    primary: dict[str, Any] | None, secondary: dict[str, Any] | None
) -> tuple[RuntimeUsageWindow | None, RuntimeUsageWindow | None]:
    session_window: RuntimeUsageWindow | None = None
    week_window: RuntimeUsageWindow | None = None
    for raw in (primary, secondary):
        if not isinstance(raw, dict):
            continue
        duration = raw.get("windowDurationMins")
        if not isinstance(duration, (int, float)):
            continue
        if duration <= _SESSION_WINDOW_MAX_MINUTES:
            session_window = _rate_limit_window_to_usage_window(raw)
        elif duration >= _WEEK_WINDOW_MIN_MINUTES:
            week_window = _rate_limit_window_to_usage_window(raw)
    return session_window, week_window
