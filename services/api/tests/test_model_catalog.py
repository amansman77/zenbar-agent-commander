import asyncio

from app import model_catalog
from app.model_catalog import RuntimeModelCatalog


class _FlakyAdapter:
    def __init__(self) -> None:
        self.reachable = False
        self.calls = 0

    async def list_models(self):
        self.calls += 1
        if not self.reachable:
            raise ConnectionRefusedError("App Server down")
        return ["gpt-a", "gpt-b"]


def test_fallback_is_cached_briefly_so_a_recovered_runtime_shows_up_fast(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(model_catalog.time, "monotonic", lambda: clock[0])
    adapter = _FlakyAdapter()
    catalog = RuntimeModelCatalog(adapter, ttl_seconds=60)  # type: ignore[arg-type]

    models, source = asyncio.run(catalog.list_models())
    assert (models, source) == (["default"], "fallback")

    adapter.reachable = True
    clock[0] += model_catalog.FALLBACK_TTL_SECONDS + 1
    models, source = asyncio.run(catalog.list_models())
    assert (models, source) == (["default", "gpt-a", "gpt-b"], "runtime")

    # A real list keeps the full TTL.
    adapter.reachable = False
    clock[0] += 30
    assert asyncio.run(catalog.list_models())[1] == "runtime"
    assert adapter.calls == 2
