from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncIterator


class EventBroker:
    def __init__(self) -> None:
        self._listeners: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)

    async def publish(self, task_id: str, payload: dict) -> None:
        encoded = f"data: {json.dumps(payload, default=str)}\n\n"
        for queue in list(self._listeners[task_id]):
            await queue.put(encoded)

    async def subscribe(self, task_id: str) -> AsyncIterator[str]:
        queue: asyncio.Queue[str] = asyncio.Queue()
        self._listeners[task_id].add(queue)
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                    yield payload
                except asyncio.TimeoutError:
                    # Keep SSE connections alive through idle periods.
                    yield ": keep-alive\n\n"
        finally:
            self._listeners[task_id].discard(queue)


broker = EventBroker()
