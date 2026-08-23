"""The runtime layer: how Zenbar talks to an agent runtime.

Zenbar never executes an agent itself. Every engine is reached through a
RuntimeAdapter, and this package holds the interface plus the two adapters
that ship with it; the CLI-backed engines live in app/*_adapter.py and import
RuntimeAdapter from here.

    base.py        the RuntimeAdapter interface and what all adapters share
    app_server.py  Codex App Server over WebSocket -- the default engine
    mock.py        in-memory adapter for tests and ZENBAR_RUNTIME_MODE=mock
    factory.py     builds one adapter per engine at startup
    diffs.py       normalizing the runtime's diff payloads into a TaskDiff
    usage.py       rate-limit windows -> account usage info

Import from the package, not its submodules: `from .runtime import
RuntimeAdapter`.
"""

from .base import RuntimeAdapter, is_default_model_alias
from .app_server import AppServerWebSocketAdapter, PendingRequest, SessionState
from .mock import MockRuntimeAdapter
from .factory import ENGINE_LABELS, create_engine_adapters, create_runtime_adapter

__all__ = [
    "ENGINE_LABELS",
    "AppServerWebSocketAdapter",
    "MockRuntimeAdapter",
    "PendingRequest",
    "RuntimeAdapter",
    "SessionState",
    "create_engine_adapters",
    "create_runtime_adapter",
    "is_default_model_alias",
]
