"""Builds the engine adapters at startup.

ZENBAR_RUNTIME_MODE picks the *default* engine only; every engine's adapter is
constructed regardless, because a task selects its engine per task. Adapters
for the CLI engines are imported lazily here to avoid a module-level import
cycle (they import RuntimeAdapter from this package).
"""

from __future__ import annotations

import os


from .app_server import AppServerWebSocketAdapter
from .base import RuntimeAdapter
from .mock import MockRuntimeAdapter

def create_runtime_adapter() -> RuntimeAdapter:
    mode = os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws")
    if mode == "mock":
        return MockRuntimeAdapter()
    if mode == "antigravity_cli":
        from ..antigravity_adapter import AntigravityCliAdapter  # deferred: avoids a module-level circular import

        return AntigravityCliAdapter()
    return AppServerWebSocketAdapter(os.getenv("ZENBAR_APP_SERVER_WS_URL", "ws://127.0.0.1:18765"))


ENGINE_LABELS = {"codex": "Codex", "antigravity": "Antigravity", "grok": "Grok", "claude": "Claude"}


def create_engine_adapters() -> tuple[dict[str, RuntimeAdapter], str]:
    """Builds every available engine's adapter (not just the one
    ZENBAR_RUNTIME_MODE picks), so a task can select its engine
    independently — ZENBAR_RUNTIME_MODE only controls which one new tasks use
    when no engine is explicitly chosen.

    Returns (adapters_by_engine_id, default_engine_id). The default engine's
    adapter instance is shared with its entry in the dict (never construct it
    twice — two AppServerWebSocketAdapter instances would each keep their own
    disconnected `_sessions` state, silently splitting a task's session
    history depending on whether its `engine` field happens to be None vs the
    literal default engine id).
    """
    mode = os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws")
    if mode == "mock":
        mock = MockRuntimeAdapter()
        return {"codex": mock, "antigravity": mock, "grok": mock, "claude": mock}, "codex"

    from ..antigravity_adapter import AntigravityCliAdapter  # deferred: avoids a module-level circular import
    from ..claude_adapter import ClaudeCliAdapter  # deferred: avoids a module-level circular import
    from ..grok_adapter import GrokCliAdapter  # deferred: avoids a module-level circular import

    adapters: dict[str, RuntimeAdapter] = {
        "codex": AppServerWebSocketAdapter(os.getenv("ZENBAR_APP_SERVER_WS_URL", "ws://127.0.0.1:18765")),
        "antigravity": AntigravityCliAdapter(),
        "grok": GrokCliAdapter(),
        "claude": ClaudeCliAdapter(),
    }
    default_engine = {"antigravity_cli": "antigravity", "grok_cli": "grok", "claude_cli": "claude"}.get(mode, "codex")
    return adapters, default_engine


def create_codex_provider_adapters() -> dict[str, RuntimeAdapter]:
    """One Codex adapter per App Server pinned to a provider, keyed by provider.

    Codex 0.166 (openai/codex#57840) accepts input on a thread only when the
    thread's provider matches the App Server's own: config.toml plus launch
    overrides, never a per-request override. The default App Server takes
    config.toml's provider, so a profile on another provider (azure) needs a
    server started with `-c model_provider=...`. ZENBAR_APP_SERVER_PROVIDER_URLS
    lists them as "azure=ws://127.0.0.1:18766,other=ws://...". The orchestrator
    routes a Codex task whose profile names one of these providers to it.
    """
    if os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws") == "mock":
        return {}
    adapters: dict[str, RuntimeAdapter] = {}
    for entry in os.getenv("ZENBAR_APP_SERVER_PROVIDER_URLS", "").split(","):
        provider, _, url = entry.strip().partition("=")
        if provider.strip() and url.strip():
            adapters[provider.strip()] = AppServerWebSocketAdapter(url.strip())
    return adapters
