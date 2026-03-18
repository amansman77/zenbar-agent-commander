from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_schema, get_db
from .app_server_manager import ManagedAppServer
from .model_catalog import RuntimeModelCatalog
from .repository import (
    add_approval,
    can_approve,
    can_retry,
    can_stop,
    create_project,
    create_task,
    get_project_any,
    get_project,
    get_task,
    list_events,
    list_projects,
    list_tasks,
    serialize_diff,
    serialize_event,
    serialize_project,
    serialize_task_detail,
    serialize_task_summary,
    soft_delete_project,
    set_task_status,
)
from .repo_discovery import (
    FolderSelectionCancelled,
    RepositoryDiscoveryError,
    discover_repository,
)
from .runtime import create_runtime_adapter
from .schemas import (
    CreateProjectRequest,
    TaskCommitRequest,
    CreateTaskRequest,
    DiscoverProjectRequest,
    DiscoverProjectResponse,
    ProjectSummary,
    RespondTaskRequest,
    RuntimeModelOption,
    RuntimeModelsResponse,
    TaskApprovalRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskGitActionResponse,
    TaskPushRequest,
    TaskSummary,
)
from .service import TaskOrchestrator, stream_task_events


orchestrator = TaskOrchestrator(create_runtime_adapter())
model_catalog = RuntimeModelCatalog(orchestrator.adapter, ttl_seconds=60)
managed_app_server = ManagedAppServer()


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _is_local_client(request: Request) -> bool:
    if request.client is None:
        return False
    return request.client.host in {"127.0.0.1", "::1", "localhost", "testclient"}


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def _verify_api_access(
    request: Request,
    x_zenbar_token: str | None = Header(default=None, alias="X-Zenbar-Token"),
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    configured_token = os.getenv("ZENBAR_API_TOKEN", "").strip()
    provided_token = (x_zenbar_token or _extract_bearer_token(authorization) or token or "").strip()
    if configured_token:
        if provided_token != configured_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
        return
    if _is_truthy(os.getenv("ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE")):
        return
    if not _is_local_client(request):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Remote access requires authentication")


def _cors_origins() -> list[str]:
    raw = os.getenv("ZENBAR_CORS_ORIGINS")
    if raw:
        origins = [item.strip() for item in raw.split(",") if item.strip()]
        if origins:
            return origins
    return ["http://127.0.0.1:5173", "http://localhost:5173"]


def _allow_credentials_for(origins: list[str]) -> bool:
    return "*" not in origins


def _safe_runtime_error_detail(prefix: str, exc: Exception) -> str:
    detail = str(exc).strip()
    allowed_fragments = (
        "Retry the task to continue.",
        "No changes to commit in Task Workspace",
        "Task has no runtime session",
        "Task workspace is not ready",
        "Task is not waiting for user input",
    )
    if any(fragment in detail for fragment in allowed_fragments):
        return detail
    return prefix


def _require_task(task, detail: str = "Task not found"):
    if task is None:
        raise HTTPException(status_code=404, detail=detail)
    return task


def _ensure_task_runtime_stream(task) -> None:
    session_id = getattr(task, "runtime_session_id", None)
    orchestrator.ensure_runtime_stream(task.id, session_id)

async def _reconcile_and_ensure_task_runtime_stream(task, db: Session):
    task = await orchestrator.reconcile_task_runtime_session(db, task)
    _ensure_task_runtime_stream(task)
    return task


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


origins = _cors_origins()
app = FastAPI(title="Zenbar Orchestration API", lifespan=lifespan, dependencies=[Depends(_verify_api_access)])
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=_allow_credentials_for(origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/projects", response_model=list[ProjectSummary])
def get_projects(db: Session = Depends(get_db)):
    return [serialize_project(item) for item in list_projects(db)]


@app.post("/projects", response_model=ProjectSummary)
def post_project(payload: CreateProjectRequest, db: Session = Depends(get_db)):
    return serialize_project(create_project(db, payload))


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    if get_project_any(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    soft_delete_project(db, project_id)
    return Response(status_code=204)


@app.post("/projects/discover", response_model=DiscoverProjectResponse)
def post_project_discovery(payload: DiscoverProjectRequest | None = None):
    try:
        return discover_repository(payload.path if payload else None)
    except FolderSelectionCancelled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RepositoryDiscoveryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/projects/{project_id}/tasks", response_model=list[TaskSummary])
def get_project_tasks(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_task_summary(item) for item in list_tasks(db, project_id)]


@app.get("/runtime/models", response_model=RuntimeModelsResponse)
async def get_runtime_models():
    models, source = await model_catalog.list_models()
    return RuntimeModelsResponse(models=[RuntimeModelOption(id=item) for item in models], source=source)


@app.post("/tasks", response_model=TaskDetail)
async def post_task(payload: CreateTaskRequest, db: Session = Depends(get_db)):
    project = get_project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    allowed_models, _ = await model_catalog.list_models()
    if payload.model not in allowed_models:
        allowed = ", ".join(allowed_models)
        raise HTTPException(status_code=400, detail=f"Invalid model '{payload.model}'. Allowed models: {allowed}")
    task = _require_task(get_task(db, create_task(db, payload).id))
    try:
        task = await orchestrator.start_task(db, task, project)
    except Exception as exc:
        task = set_task_status(db, task, "failed")
        detail = _safe_runtime_error_detail("Failed to start Codex App Server session", exc)
        raise HTTPException(status_code=502, detail=detail) from exc
    task = _require_task(get_task(db, task.id))
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}", response_model=TaskDetail)
async def get_task_detail(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}/events", response_model=list[TaskEventResponse])
async def get_task_events(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    return [serialize_event(item) for item in list_events(db, task_id)]


@app.get("/tasks/{task_id}/diff", response_model=TaskDiff)
async def get_task_diff(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    task = await orchestrator.refresh_diff(db, task)
    return serialize_diff(task)


def _assert_actionable(task):
    if task.runtime_session_id is None:
        raise HTTPException(status_code=409, detail="Task runtime session is missing")


def _assert_transition(allowed: bool, detail: str):
    if not allowed:
        raise HTTPException(status_code=409, detail=detail)


@app.post("/tasks/{task_id}/approve", response_model=TaskDetail)
async def approve_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    _assert_actionable(task)
    _assert_transition(can_approve(task.status), f"Task cannot be approved from status '{task.status}'")
    add_approval(db, task, "approve", payload.actor)
    try:
        await orchestrator.approve_task(db, task)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Approval failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = _require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/respond", response_model=TaskDetail)
async def respond_task(task_id: str, payload: RespondTaskRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    _assert_actionable(task)
    _assert_transition(task.status == "waiting_user_input", f"Task cannot accept user input from status '{task.status}'")
    try:
        await orchestrator.respond_task(db, task, payload)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Response failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = _require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/stop", response_model=TaskDetail)
async def stop_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    _assert_actionable(task)
    _assert_transition(can_stop(task.status), f"Task cannot be stopped from status '{task.status}'")
    add_approval(db, task, "stop", payload.actor)
    try:
        await orchestrator.stop_task(db, task)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Stop failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = _require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/retry", response_model=TaskDetail)
async def retry_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    _assert_transition(can_retry(task.status), f"Task cannot be retried from status '{task.status}'")
    if payload.model:
        allowed_models, _ = await model_catalog.list_models()
        if payload.model not in allowed_models:
            allowed = ", ".join(allowed_models)
            raise HTTPException(status_code=400, detail=f"Invalid model '{payload.model}'. Allowed models: {allowed}")
    add_approval(db, task, "retry", payload.actor)
    try:
        await orchestrator.retry_task(db, task, model_override=payload.model)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Retry failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = _require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/commit", response_model=TaskGitActionResponse)
async def commit_task_workspace(task_id: str, payload: TaskCommitRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    try:
        return await orchestrator.commit_workspace(db, task, payload)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Commit failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc


@app.post("/tasks/{task_id}/push", response_model=TaskGitActionResponse)
async def push_task_workspace(task_id: str, payload: TaskPushRequest, db: Session = Depends(get_db)):
    task = _require_task(get_task(db, task_id))
    try:
        return await orchestrator.push_workspace(db, task, payload)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Push failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc


@app.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    return StreamingResponse(stream_task_events(task_id), media_type="text/event-stream")
