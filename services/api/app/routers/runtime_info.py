"""Read-only runtime metadata: engines, models, profiles, skills, usage."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from ..codex_profiles import list_profiles as list_codex_profiles
from ..runtime import ENGINE_LABELS
from ..runtime_registry import adapter_for_engine, model_catalog_for, orchestrator
from ..schemas import (
    RuntimeEngineOption,
    RuntimeEnginesResponse,
    RuntimeModelOption,
    RuntimeModelsResponse,
    RuntimeProfileOption,
    RuntimeProfilesResponse,
    RuntimeSkillsResponse,
    RuntimeUsageInfo,
    RuntimeUsageResponse,
)
from ..ttl_cache import TtlCache

router = APIRouter()


usage_cache: TtlCache[RuntimeUsageInfo | None] = TtlCache(ttl_seconds=60.0)


@router.get("/runtime/engines", response_model=RuntimeEnginesResponse)
def get_runtime_engines():
    return RuntimeEnginesResponse(
        engines=[
            RuntimeEngineOption(id=engine, label=ENGINE_LABELS.get(engine, engine))
            for engine in orchestrator.adapters
        ],
        default_engine=orchestrator.default_engine,
    )


@router.get("/runtime/models", response_model=RuntimeModelsResponse)
async def get_runtime_models(engine: str | None = None):
    models, source = await model_catalog_for(engine).list_models()
    return RuntimeModelsResponse(models=[RuntimeModelOption(id=item) for item in models], source=source)


@router.get("/runtime/profiles", response_model=RuntimeProfilesResponse)
async def get_runtime_profiles():
    profiles = await asyncio.to_thread(list_codex_profiles)
    return RuntimeProfilesResponse(
        profiles=[
            RuntimeProfileOption(id=item.id, description=item.description, model=item.model)
            for item in profiles
        ]
    )


@router.get("/runtime/skills", response_model=RuntimeSkillsResponse)
async def get_runtime_skills():
    skills = await orchestrator.adapter.list_skills()
    if skills is None:
        return RuntimeSkillsResponse(skills=[], source="fallback")
    return RuntimeSkillsResponse(skills=skills, source="runtime")


@router.get("/runtime/usage", response_model=RuntimeUsageResponse)
async def get_runtime_usage(engine: str):
    adapter = adapter_for_engine(engine)
    # Antigravity's get_usage() is a real ~1-3s subprocess spawn per call --
    # the compose bar and the desktop Task Detail panel can both be polling
    # this at once, so a short cache absorbs a burst of concurrent requests
    # into one actual call instead of one each.
    usage = await usage_cache.get_or_fetch(engine, adapter.get_usage)
    return RuntimeUsageResponse(engine=engine, usage=usage)
