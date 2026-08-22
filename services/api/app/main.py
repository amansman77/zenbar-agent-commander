"""FastAPI application for the Zenbar Orchestration API.

This module only wires things together: schema bootstrap and Codex App Server
lifecycle (`lifespan`), CORS, the global auth dependency, and router
registration. Every endpoint lives in `app/routers/`; the process-wide runtime
singletons live in `app/runtime_registry.py`.

Route map:
    routers/projects.py         /projects, /projects/discover, /projects/{id}/tasks
    routers/project_prompts.py  /projects/{id}/prompts, /projects/{id}/pipelines
    routers/conversations.py    /conversations...
    routers/tasks.py            /tasks..., /sessions/{id}/turns
    routers/runtime_info.py     /runtime/engines|models|profiles|skills|usage
    routers/fs.py               /fs/browse
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import Base, ensure_schema, engine
from .routers import conversations, fs, project_prompts, projects, runtime_info, tasks
from .runtime_registry import managed_app_server, orchestrator
from .security import allow_credentials_for, cors_origins, verify_api_access

# Re-exported so `from app.main import orchestrator, model_catalog` keeps
# working for callers (and tests) written before the router split.
from .runtime_registry import model_catalog, model_catalogs  # noqa: F401  isort:skip


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_schema()
    await orchestrator.reconcile_active_tasks()
    await managed_app_server.start()
    try:
        yield
    finally:
        await managed_app_server.stop()


origins = cors_origins()
app = FastAPI(title="Zenbar Orchestration API", lifespan=lifespan, dependencies=[Depends(verify_api_access)])
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_credentials_for(origins),
    allow_methods=["*"],
    allow_headers=["*"],
    # Browsers only expose the CORS-safelisted response headers to JS by
    # default -- without this, fetch()'s Response.headers.get() would come
    # back null for this custom header on every cross-origin request (the
    # normal case here: the web app runs on a different port than the API).
    expose_headers=["X-Excluded-Event-Count", "X-Latest-Event-At"],
)

app.include_router(projects.router)
app.include_router(project_prompts.router)
app.include_router(conversations.router)
app.include_router(tasks.router)
app.include_router(runtime_info.router)
app.include_router(fs.router)
