"""Process-wide runtime singletons shared by every router.

One adapter per engine (codex/antigravity/grok/claude), the single
TaskOrchestrator built on top of them, the per-engine model catalogs, and the
managed Codex App Server. Routers import these from here rather than from
main.py, so main.py can import the routers without a circular import.
"""

from __future__ import annotations

from fastapi import HTTPException

from .app_server_manager import ManagedAppServer
from .codex_profiles import get_profile as get_codex_profile
from .model_catalog import RuntimeModelCatalog
from .runtime import RuntimeAdapter, create_engine_adapters
from .service import TaskOrchestrator

engine_adapters, default_engine = create_engine_adapters()
orchestrator = TaskOrchestrator(engine_adapters, default_engine)
model_catalogs: dict[str, RuntimeModelCatalog] = {
    engine: RuntimeModelCatalog(adapter, ttl_seconds=60) for engine, adapter in engine_adapters.items()
}
model_catalog = model_catalogs[default_engine]  # back-compat alias for the default engine's catalog
managed_app_server = ManagedAppServer()


def model_catalog_for(engine: str | None) -> RuntimeModelCatalog:
    if engine is None:
        return model_catalog
    catalog = model_catalogs.get(engine)
    if catalog is None:
        allowed = ", ".join(sorted(model_catalogs))
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Allowed engines: {allowed}")
    return catalog


def adapter_for_engine(engine: str) -> RuntimeAdapter:
    adapter = engine_adapters.get(engine)
    if adapter is None:
        allowed = ", ".join(sorted(engine_adapters))
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Allowed engines: {allowed}")
    return adapter


def validate_task_model(model: str, profile_id: str | None, allowed_models: list[str]) -> None:
    # A selected profile with its own declared model always wins over an
    # explicit model pick (see TaskForm's profileControlsModel on the
    # frontend, which sends the profile's model rather than letting the user
    # pick one) -- and that model may legitimately be outside the generic
    # engine-wide catalog, e.g. an Azure OpenAI deployment name like
    # "inoberry-amansman77-gpt-5.5" rather than a plain "gpt-5.5". Validating
    # it against `allowed_models` here was rejecting every task created with
    # such a profile with a 400. Skip the catalog check in that case; the
    # profile itself is the source of truth for whether the model is valid.
    if profile_id:
        profile = get_codex_profile(profile_id)
        if profile is not None and profile.model:
            return
    if model not in allowed_models:
        allowed = ", ".join(allowed_models)
        raise HTTPException(status_code=400, detail=f"Invalid model '{model}'. Allowed models: {allowed}")
