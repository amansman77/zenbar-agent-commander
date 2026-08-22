"""Minimal async TTL cache used for model lists, PR info, and usage lookups."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

T = TypeVar("T")


class TtlCache(Generic[T]):
    """A tiny in-process cache for the "poll a slow/external source every
    few seconds, but its answer barely changes that often" shape.

    Same idea as RuntimeModelCatalog's own hand-rolled cache
    (model_catalog.py), generalized so it doesn't get reimplemented per call
    site -- used for the PR/MR GitHub/GitLab API calls (pr_info.py) and each
    engine's account-level usage check (main.py's /runtime/usage;
    Antigravity's is a real ~1-3s subprocess spawn per call). Per-key
    locking so a burst of concurrent requests for the *same* key (e.g. two
    browser tabs polling the same PR at once) only pays for one real fetch,
    while different keys don't block each other.
    """

    def __init__(self, ttl_seconds: float = 60.0) -> None:
        self._ttl_seconds = ttl_seconds
        self._store: dict[str, tuple[float, T]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_or_fetch(self, key: str, fetch: Callable[[], Awaitable[T]]) -> T:
        now = time.monotonic()
        cached = self._store.get(key)
        if cached is not None and now < cached[0]:
            return cached[1]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            cached = self._store.get(key)
            if cached is not None and now < cached[0]:
                return cached[1]
            value = await fetch()
            self._store[key] = (now + self._ttl_seconds, value)
            return value
