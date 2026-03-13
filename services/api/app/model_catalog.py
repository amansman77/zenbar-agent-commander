from __future__ import annotations

import asyncio
import os
import time

from .runtime import RuntimeAdapter


def _load_fallback_models() -> list[str]:
    raw = os.getenv("ZENBAR_FALLBACK_MODELS", "default")
    normalized = [item.strip() for item in raw.split(",") if item.strip()]
    if not normalized:
        return ["default"]
    return list(dict.fromkeys(normalized))


FALLBACK_MODELS = _load_fallback_models()


class RuntimeModelCatalog:
    def __init__(self, adapter: RuntimeAdapter, ttl_seconds: int = 60) -> None:
        self._adapter = adapter
        self._ttl_seconds = ttl_seconds
        self._lock = asyncio.Lock()
        self._cached_models: list[str] | None = None
        self._cached_source: str = "fallback"
        self._expires_at = 0.0

    async def list_models(self) -> tuple[list[str], str]:
        now = time.monotonic()
        if self._cached_models is not None and now < self._expires_at:
            return self._cached_models, self._cached_source

        async with self._lock:
            now = time.monotonic()
            if self._cached_models is not None and now < self._expires_at:
                return self._cached_models, self._cached_source

            models = await self._load_runtime_models()
            source = "runtime" if models else "fallback"
            resolved_base = models if models else FALLBACK_MODELS
            resolved = ["default", *[item for item in resolved_base if item != "default"]]
            self._cached_models = resolved
            self._cached_source = source
            self._expires_at = time.monotonic() + self._ttl_seconds
            return resolved, source

    async def _load_runtime_models(self) -> list[str] | None:
        try:
            models = await self._adapter.list_models()
        except Exception:
            return None
        if not models:
            return None
        normalized = [item.strip() for item in models if isinstance(item, str) and item.strip()]
        if not normalized:
            return None
        return list(dict.fromkeys(normalized))

    def clear_cache(self) -> None:
        self._cached_models = None
        self._cached_source = "fallback"
        self._expires_at = 0.0
