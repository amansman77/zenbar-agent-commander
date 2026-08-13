from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_schema, get_db
from .app_server_manager import ManagedAppServer
from .codex_profiles import list_profiles as list_codex_profiles
from .codex_project_trust import add_project_trust_entry
from .model_catalog import RuntimeModelCatalog
from .repository import (
    add_approval,
    add_conversation_message,
    can_approve,
    can_retry,
    can_stop,
    create_conversation,
    delete_conversation,
    delete_task,
    create_project,
    create_project_prompt,
    create_task,
    delete_project_prompt,
    get_conversation,
    get_project_any,
    get_project,
    get_project_prompt,
    get_task,
    get_task_by_session_id,
    list_conversations,
    list_events,
    list_project_prompts,
    list_projects,
    list_tasks,
    serialize_conversation_detail,
    serialize_conversation_message,
    serialize_conversation_summary,
    serialize_diff,
    serialize_event,
    serialize_project,
    serialize_project_prompt,
    serialize_task_detail,
    serialize_task_summary,
    set_conversation_task_id,
    soft_delete_project,
    set_task_status,
    update_project_prompt,
)
from .repo_discovery import (
    FolderSelectionCancelled,
    RepositoryDiscoveryError,
    discover_repository,
)
from .runtime import ENGINE_LABELS, create_engine_adapters
from .workspace import cleanup_workspace
from .schemas import (
    AddConversationMessageRequest,
    ConversationDetail,
    ConversationMessageItem,
    ConversationSummary,
    CreateConversationRequest,
    CreateProjectPromptRequest,
    CreateProjectRequest,
    TaskCommitRequest,
    CreateTaskRequest,
    DiscoverProjectRequest,
    DiscoverProjectResponse,
    FsBrowseEntry,
    FsBrowseResponse,
    ProjectPromptItem,
    ProjectSummary,
    RespondTaskRequest,
    RuntimeEngineOption,
    RuntimeEnginesResponse,
    RuntimeModelOption,
    RuntimeModelsResponse,
    RuntimeProfileOption,
    RuntimeProfilesResponse,
    RuntimeSkill,
    RuntimeSkillsResponse,
    FollowupTurnRequest,
    TaskApprovalRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskGitActionResponse,
    TaskPushRequest,
    TaskSummary,
    UpdateProjectPromptRequest,
)
from .service import TaskOrchestrator, stream_task_events


_engine_adapters, _default_engine = create_engine_adapters()
orchestrator = TaskOrchestrator(_engine_adapters, _default_engine)
model_catalogs: dict[str, RuntimeModelCatalog] = {
    engine: RuntimeModelCatalog(adapter, ttl_seconds=60) for engine, adapter in _engine_adapters.items()
}
model_catalog = model_catalogs[_default_engine]  # back-compat alias for the default engine's catalog
managed_app_server = ManagedAppServer()


def _model_catalog_for(engine: str | None) -> RuntimeModelCatalog:
    if engine is None:
        return model_catalog
    catalog = model_catalogs.get(engine)
    if catalog is None:
        allowed = ", ".join(sorted(model_catalogs))
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Allowed engines: {allowed}")
    return catalog


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
    project = create_project(db, payload)
    try:
        # Trust the repo once at the Project level so every task worktree
        # created under it (see workspace.prepare_workspace) is automatically
        # trusted by Codex too — see add_project_trust_entry for why.
        add_project_trust_entry(project.repo_path)
    except Exception:
        pass
    return serialize_project(project)


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    if get_project_any(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    soft_delete_project(db, project_id)
    return Response(status_code=204)


@app.get("/projects/{project_id}/prompts", response_model=list[ProjectPromptItem])
def get_project_prompts(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_project_prompt(item) for item in list_project_prompts(db, project_id)]


@app.post("/projects/{project_id}/prompts", response_model=ProjectPromptItem, status_code=201)
def post_project_prompt(project_id: str, payload: CreateProjectPromptRequest, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return serialize_project_prompt(create_project_prompt(db, project_id, payload))


@app.patch("/projects/{project_id}/prompts/{prompt_id}", response_model=ProjectPromptItem)
def patch_project_prompt(
    project_id: str, prompt_id: str, payload: UpdateProjectPromptRequest, db: Session = Depends(get_db)
):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    prompt = get_project_prompt(db, prompt_id)
    if prompt is None or prompt.project_id != project_id:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return serialize_project_prompt(update_project_prompt(db, prompt, payload))


@app.delete("/projects/{project_id}/prompts/{prompt_id}", status_code=204)
def delete_project_prompt_endpoint(project_id: str, prompt_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    prompt = get_project_prompt(db, prompt_id)
    if prompt is None or prompt.project_id != project_id:
        raise HTTPException(status_code=404, detail="Prompt not found")
    delete_project_prompt(db, prompt_id)
    return Response(status_code=204)


@app.post("/projects/discover", response_model=DiscoverProjectResponse)
def post_project_discovery(payload: DiscoverProjectRequest | None = None):
    try:
        return discover_repository(payload.path if payload else None)
    except FolderSelectionCancelled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RepositoryDiscoveryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/conversations", response_model=list[ConversationSummary])
def get_conversations(db: Session = Depends(get_db)):
    convs = list_conversations(db)
    return [serialize_conversation_summary(c) for c in convs]


@app.post("/conversations", response_model=ConversationDetail, status_code=201)
def post_conversation(payload: CreateConversationRequest = CreateConversationRequest(), db: Session = Depends(get_db)):
    conv = create_conversation(db, payload)
    conv_with_messages = get_conversation(db, conv.id)
    return serialize_conversation_detail(conv_with_messages)


@app.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation_detail(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return serialize_conversation_detail(conv)


@app.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation_endpoint(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.task:
        repo_path = conv.task.project.repo_path if conv.task.project else None
        cleanup_workspace(conv.task.workspace_path, conv.task.workspace_type, repo_path)
        delete_task(db, conv.task.id)
    delete_conversation(db, conversation_id)
    return Response(status_code=204)


@app.post("/conversations/{conversation_id}/messages", response_model=ConversationDetail, status_code=201)
async def post_conversation_message(
    conversation_id: str,
    payload: AddConversationMessageRequest,
    db: Session = Depends(get_db),
):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    add_conversation_message(db, conversation_id, payload)

    if payload.role == "user":
        conv = get_conversation(db, conversation_id)
        selected_skill = payload.selected_skill or None
        if conv.task_id is None:
            project = get_project(db, conv.project_id) if conv.project_id else None
            if project is None:
                raise HTTPException(status_code=400, detail="Conversation has no associated project")
            allowed_models, _ = await _model_catalog_for(payload.engine).list_models()
            default_model = allowed_models[0] if allowed_models else "default"
            task_request = CreateTaskRequest(
                project_id=project.id,
                title=payload.content[:50].strip() or "Conversation",
                prompt=payload.content,
                engine=payload.engine,
                model=payload.model or default_model,
                profile=payload.profile,
                reasoning_effort="medium",
                execution_mode="execute",
                workspace_type="worktree",
            )
            task = create_task(db, task_request, project_name=project.name)
            task = get_task(db, task.id)
            set_conversation_task_id(db, conversation_id, task.id)
            db.expire_all()
            try:
                await orchestrator.start_task(db, task, project, selected_skill=selected_skill)
            except Exception as exc:
                set_task_status(db, task, "failed")
                detail = _safe_runtime_error_detail("Failed to start Codex session", exc)
                raise HTTPException(status_code=502, detail=detail) from exc
        else:
            task = get_task(db, conv.task_id)
            if task is not None and task.status in {"completed", "stopped", "failed"}:
                try:
                    await orchestrator.followup_task(db, task, payload.content, selected_skill=selected_skill)
                except Exception as exc:
                    exc_msg = str(exc)
                    session_expired = (
                        "Unknown Codex App Server session" in exc_msg
                        or "Task has no runtime session" in exc_msg
                    )
                    if not session_expired:
                        detail = _safe_runtime_error_detail("Follow-up failed", exc)
                        raise HTTPException(status_code=409, detail=detail) from exc
                    # Session expired — restart Codex in the same task workspace
                    project = get_project(db, conv.project_id) if conv.project_id else None
                    if project is None:
                        raise HTTPException(status_code=400, detail="Conversation has no associated project") from exc
                    task = get_task(db, conv.task_id)
                    db.expire_all()
                    try:
                        await orchestrator.start_task(db, task, project, selected_skill=selected_skill)
                    except Exception as start_exc:
                        set_task_status(db, task, "failed")
                        detail = _safe_runtime_error_detail("Failed to restart Codex session", start_exc)
                        raise HTTPException(status_code=502, detail=detail) from start_exc

    conv = get_conversation(db, conversation_id)
    return serialize_conversation_detail(conv)


@app.get("/fs/browse", response_model=FsBrowseResponse)
def get_fs_browse(path: str | None = None):
    from pathlib import Path

    browse_path = Path(path).expanduser().resolve() if path else Path.home()
    if not browse_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    try:
        entries = sorted(
            [
                FsBrowseEntry(name=entry.name, path=str(entry))
                for entry in browse_path.iterdir()
                if entry.is_dir() and not entry.name.startswith(".")
            ],
            key=lambda e: e.name.lower(),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    parent = str(browse_path.parent) if browse_path != browse_path.parent else None
    return FsBrowseResponse(path=str(browse_path), parent=parent, entries=entries)


@app.get("/projects/{project_id}/tasks", response_model=list[TaskSummary])
def get_project_tasks(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_task_summary(item) for item in list_tasks(db, project_id)]


@app.get("/runtime/engines", response_model=RuntimeEnginesResponse)
def get_runtime_engines():
    return RuntimeEnginesResponse(
        engines=[
            RuntimeEngineOption(id=engine, label=ENGINE_LABELS.get(engine, engine))
            for engine in orchestrator.adapters
        ],
        default_engine=orchestrator.default_engine,
    )


@app.get("/runtime/models", response_model=RuntimeModelsResponse)
async def get_runtime_models(engine: str | None = None):
    models, source = await _model_catalog_for(engine).list_models()
    return RuntimeModelsResponse(models=[RuntimeModelOption(id=item) for item in models], source=source)


@app.get("/runtime/profiles", response_model=RuntimeProfilesResponse)
async def get_runtime_profiles():
    profiles = await asyncio.to_thread(list_codex_profiles)
    return RuntimeProfilesResponse(
        profiles=[
            RuntimeProfileOption(id=item.id, description=item.description, model=item.model)
            for item in profiles
        ]
    )


@app.get("/runtime/skills", response_model=RuntimeSkillsResponse)
async def get_runtime_skills():
    skills = await orchestrator.adapter.list_skills()
    if skills is None:
        return RuntimeSkillsResponse(skills=[], source="fallback")
    return RuntimeSkillsResponse(skills=skills, source="runtime")


@app.post("/tasks", response_model=TaskDetail)
async def post_task(payload: CreateTaskRequest, db: Session = Depends(get_db)):
    project = get_project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    allowed_models, _ = await _model_catalog_for(payload.engine).list_models()
    if payload.model not in allowed_models:
        allowed = ", ".join(allowed_models)
        raise HTTPException(status_code=400, detail=f"Invalid model '{payload.model}'. Allowed models: {allowed}")
    task = _require_task(get_task(db, create_task(db, payload, project_name=project.name).id))
    try:
        task = await orchestrator.start_task(db, task, project)
    except Exception as exc:
        task = set_task_status(db, task, "failed")
        detail = _safe_runtime_error_detail("Failed to start Codex App Server session", exc)
        raise HTTPException(status_code=502, detail=detail) from exc
    task = _require_task(get_task(db, task.id))
    return serialize_task_detail(task)


@app.delete("/tasks/{task_id}", status_code=204)
def delete_task_endpoint(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    repo_path = task.project.repo_path if task.project else None
    cleanup_workspace(task.workspace_path, task.workspace_type, repo_path)
    delete_task(db, task_id)
    return Response(status_code=204)


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
        allowed_models, _ = await _model_catalog_for(task.engine).list_models()
        if payload.model not in allowed_models:
            allowed = ", ".join(allowed_models)
            raise HTTPException(status_code=400, detail=f"Invalid model '{payload.model}'. Allowed models: {allowed}")
    add_approval(db, task, "retry", payload.actor)
    try:
        await orchestrator.retry_task(db, task, model_override=payload.model, profile_override=payload.profile)
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


@app.post("/sessions/{session_id}/turns", response_model=TaskDetail)
async def post_session_turn(session_id: str, payload: FollowupTurnRequest, db: Session = Depends(get_db)):
    task = get_task_by_session_id(db, session_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Session not found")
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Follow-up content cannot be empty")
    try:
        await orchestrator.followup_task(db, task, content)
    except Exception as exc:
        detail = _safe_runtime_error_detail("Follow-up failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = _require_task(get_task(db, task.id))
    return serialize_task_detail(task)


@app.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    return StreamingResponse(stream_task_events(task_id), media_type="text/event-stream")
