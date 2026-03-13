from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_schema, get_db
from .app_server_manager import ManagedAppServer
from .repository import (
    add_approval,
    can_approve,
    can_retry,
    can_stop,
    create_project,
    create_task,
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
    CreateTaskRequest,
    DiscoverProjectRequest,
    DiscoverProjectResponse,
    ProjectSummary,
    RespondTaskRequest,
    TaskApprovalRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskSummary,
)
from .service import TaskOrchestrator, stream_task_events


orchestrator = TaskOrchestrator(create_runtime_adapter())
managed_app_server = ManagedAppServer()


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_schema()
    await managed_app_server.start()
    try:
        yield
    finally:
        await managed_app_server.stop()


app = FastAPI(title="Zenbar Orchestration API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/projects", response_model=list[ProjectSummary])
def get_projects(db: Session = Depends(get_db)):
    return [serialize_project(item) for item in list_projects(db)]


@app.post("/projects", response_model=ProjectSummary)
def post_project(payload: CreateProjectRequest, db: Session = Depends(get_db)):
    return serialize_project(create_project(db, payload))


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
    return [serialize_task_summary(item) for item in list_tasks(db, project_id)]


@app.post("/tasks", response_model=TaskDetail)
async def post_task(payload: CreateTaskRequest, db: Session = Depends(get_db)):
    project = get_project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    task = create_task(db, payload)
    task = get_task(db, task.id)
    assert task is not None
    try:
        task = await orchestrator.start_task(db, task, project)
    except Exception as exc:
        task = set_task_status(db, task, "failed")
        raise HTTPException(status_code=502, detail=f"Failed to start Codex App Server session: {exc}") from exc
    task = get_task(db, task.id)
    assert task is not None
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}", response_model=TaskDetail)
def get_task_detail(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}/events", response_model=list[TaskEventResponse])
def get_task_events(task_id: str, db: Session = Depends(get_db)):
    if get_task(db, task_id) is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return [serialize_event(item) for item in list_events(db, task_id)]


@app.get("/tasks/{task_id}/diff", response_model=TaskDiff)
async def get_task_diff(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
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
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_actionable(task)
    _assert_transition(can_approve(task.status), f"Task cannot be approved from status '{task.status}'")
    add_approval(db, task, "approve", payload.actor)
    try:
        await orchestrator.approve_task(db, task)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"Approval failed: {exc}") from exc
    task = get_task(db, task_id)
    assert task is not None
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/respond", response_model=TaskDetail)
async def respond_task(task_id: str, payload: RespondTaskRequest, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_actionable(task)
    _assert_transition(task.status == "waiting_user_input", f"Task cannot accept user input from status '{task.status}'")
    try:
        await orchestrator.respond_task(db, task, payload)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"Response failed: {exc}") from exc
    task = get_task(db, task_id)
    assert task is not None
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/stop", response_model=TaskDetail)
async def stop_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_actionable(task)
    _assert_transition(can_stop(task.status), f"Task cannot be stopped from status '{task.status}'")
    add_approval(db, task, "stop", payload.actor)
    try:
        await orchestrator.stop_task(db, task)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"Stop failed: {exc}") from exc
    task = get_task(db, task_id)
    assert task is not None
    return serialize_task_detail(task)


@app.post("/tasks/{task_id}/retry", response_model=TaskDetail)
async def retry_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_transition(can_retry(task.status), f"Task cannot be retried from status '{task.status}'")
    add_approval(db, task, "retry", payload.actor)
    try:
        await orchestrator.retry_task(db, task)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"Retry failed: {exc}") from exc
    task = get_task(db, task_id)
    assert task is not None
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str, db: Session = Depends(get_db)):
    if get_task(db, task_id) is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return StreamingResponse(stream_task_events(task_id), media_type="text/event-stream")
