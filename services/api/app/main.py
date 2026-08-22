from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .db import Base, engine, ensure_schema, get_db
from .app_server_manager import ManagedAppServer
from .codex_profiles import get_profile as get_codex_profile
from .codex_profiles import list_profiles as list_codex_profiles
from .codex_project_trust import add_project_trust_entry
from .github_pr import MergeResult, merge_pull_request_for_branch
from .pr_info import fetch_pr_or_mr_diff, fetch_pr_or_mr_info, find_all_pr_or_mr_urls, find_latest_pr_or_mr_url
from .model_catalog import RuntimeModelCatalog
from .ttl_cache import TtlCache
from .repository import (
    add_approval,
    add_conversation_message,
    append_event,
    can_approve,
    can_retry,
    can_stop,
    count_conversations_by_project,
    count_events,
    create_conversation,
    delete_conversation,
    delete_task,
    create_project,
    create_project_pipeline,
    create_project_prompt,
    create_task,
    delete_project_pipeline,
    delete_project_prompt,
    get_conversation,
    get_conversation_for_task,
    get_project_any,
    get_project,
    get_project_pipeline,
    get_project_prompt,
    get_task,
    get_task_by_session_id,
    latest_event_at,
    list_conversations,
    list_events,
    list_project_pipelines,
    list_project_prompts,
    list_projects,
    list_tasks,
    serialize_conversation_detail,
    serialize_conversation_message,
    serialize_conversation_summary,
    serialize_diff,
    serialize_event,
    serialize_project,
    serialize_project_pipeline,
    serialize_project_prompt,
    serialize_task_detail,
    serialize_task_summary,
    set_conversation_task_id,
    soft_delete_project,
    set_task_status,
    update_project_pipeline,
    update_project_prompt,
)
from .repo_discovery import (
    FolderSelectionCancelled,
    RepositoryDiscoveryError,
    discover_repository,
)
from .runtime import ENGINE_LABELS, RuntimeAdapter, create_engine_adapters
from .workspace import cleanup_workspace
from .schemas import (
    AddConversationMessageRequest,
    ConversationDetail,
    ConversationMessageItem,
    ConversationSummary,
    CreateConversationRequest,
    CreateProjectPipelineRequest,
    CreateProjectPromptRequest,
    CreateProjectRequest,
    TaskCommitRequest,
    CreateTaskRequest,
    DiscoverProjectRequest,
    DiscoverProjectResponse,
    FsBrowseEntry,
    FsBrowseResponse,
    ProjectPipelineItem,
    ProjectPromptItem,
    ProjectSummary,
    RespondTaskRequest,
    RuntimeEngineOption,
    RuntimeEvent,
    RuntimeEnginesResponse,
    RuntimeModelOption,
    RuntimeModelsResponse,
    RuntimeProfileOption,
    RuntimeProfilesResponse,
    RuntimeSkill,
    RuntimeSkillsResponse,
    RuntimeUsageInfo,
    RuntimeUsageResponse,
    PrInfoResponse,
    FollowupTurnRequest,
    TaskApprovalRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskGitActionResponse,
    TaskPushRequest,
    TaskSummary,
    UpdateProjectPipelineRequest,
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
_usage_cache: TtlCache[RuntimeUsageInfo | None] = TtlCache(ttl_seconds=60.0)


def _model_catalog_for(engine: str | None) -> RuntimeModelCatalog:
    if engine is None:
        return model_catalog
    catalog = model_catalogs.get(engine)
    if catalog is None:
        allowed = ", ".join(sorted(model_catalogs))
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Allowed engines: {allowed}")
    return catalog


def _adapter_for_engine(engine: str) -> RuntimeAdapter:
    adapter = _engine_adapters.get(engine)
    if adapter is None:
        allowed = ", ".join(sorted(_engine_adapters))
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'. Allowed engines: {allowed}")
    return adapter


def _validate_task_model(model: str, profile_id: str | None, allowed_models: list[str]) -> None:
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
    # Browsers only expose the CORS-safelisted response headers to JS by
    # default -- without this, fetch()'s Response.headers.get() would come
    # back null for this custom header on every cross-origin request (the
    # normal case here: the web app runs on a different port than the API).
    expose_headers=["X-Excluded-Event-Count", "X-Latest-Event-At"],
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


def _validate_pipeline_prompt_ids(db: Session, project_id: str, prompt_ids: list[str]) -> None:
    for prompt_id in prompt_ids:
        prompt = get_project_prompt(db, prompt_id)
        if prompt is None or prompt.project_id != project_id:
            raise HTTPException(status_code=400, detail=f"Prompt '{prompt_id}' not found in this project")


@app.get("/projects/{project_id}/pipelines", response_model=list[ProjectPipelineItem])
def get_project_pipelines(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_project_pipeline(item) for item in list_project_pipelines(db, project_id)]


@app.post("/projects/{project_id}/pipelines", response_model=ProjectPipelineItem, status_code=201)
def post_project_pipeline(project_id: str, payload: CreateProjectPipelineRequest, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    _validate_pipeline_prompt_ids(db, project_id, payload.prompt_ids)
    return serialize_project_pipeline(create_project_pipeline(db, project_id, payload))


@app.patch("/projects/{project_id}/pipelines/{pipeline_id}", response_model=ProjectPipelineItem)
def patch_project_pipeline(
    project_id: str, pipeline_id: str, payload: UpdateProjectPipelineRequest, db: Session = Depends(get_db)
):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    pipeline = get_project_pipeline(db, pipeline_id)
    if pipeline is None or pipeline.project_id != project_id:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    if payload.prompt_ids is not None:
        _validate_pipeline_prompt_ids(db, project_id, payload.prompt_ids)
    return serialize_project_pipeline(update_project_pipeline(db, pipeline, payload))


@app.delete("/projects/{project_id}/pipelines/{pipeline_id}", status_code=204)
def delete_project_pipeline_endpoint(project_id: str, pipeline_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    pipeline = get_project_pipeline(db, pipeline_id)
    if pipeline is None or pipeline.project_id != project_id:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    delete_project_pipeline(db, pipeline_id)
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
def get_conversations(db: Session = Depends(get_db), preview_count: int | None = Query(default=None)):
    convs = list_conversations(db, preview_count=preview_count)
    return [serialize_conversation_summary(c) for c in convs]


@app.get("/conversations/counts", response_model=dict[str, int])
def get_conversation_counts(db: Session = Depends(get_db)):
    # Paired with GET /conversations?preview_count=N: that response omits
    # conversations past each project's preview cutoff, so the "더보기 (N)"
    # button needs the true per-project total from somewhere else to show
    # its count before the user has actually asked to see the rest.
    counts = count_conversations_by_project(db)
    return {(project_id or "__no_project__"): count for project_id, count in counts.items()}


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


@app.get("/conversations/{conversation_id}/pr-info", response_model=list[PrInfoResponse])
async def get_conversation_pr_info(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    texts = [m.content for m in conv.messages if m.content]
    urls = find_all_pr_or_mr_urls(texts)
    if not urls:
        return []
    # Most-recently-mentioned first (find_all_pr_or_mr_urls' own order) --
    # fetched in parallel since a longer conversation can have several. Each
    # PR/MR's own diff is fetched alongside its info (both TTL-cached by
    # pr_info.py) to attach a files_changed list to that card specifically
    # -- without this, several cards next to one flat file list left no way
    # to tell which files belonged to which PR/MR.
    infos, diffs = await asyncio.gather(
        asyncio.gather(*(fetch_pr_or_mr_info(url) for url in urls)),
        asyncio.gather(*(fetch_pr_or_mr_diff(url) for url in urls)),
    )
    return [
        PrInfoResponse(
            platform=info.platform,
            number=info.number,
            title=info.title,
            description=info.description,
            state=info.state,
            url=info.url,
            source_branch=info.source_branch,
            target_branch=info.target_branch,
            author=info.author,
            merged_at=info.merged_at,
            # raw_diff dropped here -- this list is polled every 15s while
            # a task is active, and raw_diff is where nearly all of the
            # payload lives (measured live: 95KB of a 110KB response, for
            # cards the user hadn't even expanded). files_changed (just
            # filenames) is what the collapsed "변경 파일 보기 (N)" toggle
            # actually needs; the full diff is fetched separately, on
            # demand, only once a specific card is expanded (see
            # get_conversation_pr_diff below).
            diff=diff.model_copy(update={"raw_diff": None}) if diff else None,
        )
        for info, diff in zip(infos, diffs)
        if info is not None
    ]


@app.get("/conversations/{conversation_id}/pr-diff", response_model=TaskDiff)
async def get_conversation_pr_diff(conversation_id: str, url: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    texts = [m.content for m in conv.messages if m.content]
    # Scoped to PR/MR URLs actually mentioned in this conversation, rather
    # than accepting any URL -- keeps this from doubling as an open GitHub/
    # GitLab diff proxy for whatever URL a caller passes in.
    if url not in find_all_pr_or_mr_urls(texts):
        raise HTTPException(status_code=404, detail="PR/MR not found in this conversation")
    diff = await fetch_pr_or_mr_diff(url)
    return diff or TaskDiff()


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

    # Starting a pipeline: resolve it up front (before saving the visible
    # message) so the first step's actual prompt content becomes the task's
    # prompt. The compose bar doesn't require typing anything when a
    # pipeline is selected -- but if the user *did* type something (e.g. an
    # issue number the saved prompt template has no way to fill in itself),
    # it's prepended to the first step's content rather than discarded, so
    # a pipeline can still be pointed at a specific target when started.
    # Steps 2+ are unaffected -- they're only ever taken verbatim from
    # pipeline_steps_json (see TaskOrchestrator._advance_pipeline_if_needed),
    # never re-derived from this request.
    pipeline = None
    pipeline_steps: list[dict] | None = None
    if payload.role == "user" and payload.pipeline_id and conv.task_id is None:
        project_for_pipeline = get_project(db, conv.project_id) if conv.project_id else None
        if project_for_pipeline is None:
            raise HTTPException(status_code=400, detail="Conversation has no associated project")
        pipeline = get_project_pipeline(db, payload.pipeline_id)
        if pipeline is None or pipeline.project_id != project_for_pipeline.id:
            raise HTTPException(status_code=404, detail="Pipeline not found")
        prompt_ids = json.loads(pipeline.prompt_ids_json or "[]")
        if not prompt_ids:
            raise HTTPException(status_code=400, detail="Pipeline has no prompts")
        pipeline_steps = []
        for prompt_id in prompt_ids:
            prompt = get_project_prompt(db, prompt_id)
            if prompt is None or prompt.project_id != project_for_pipeline.id:
                raise HTTPException(status_code=400, detail=f"Pipeline references a missing prompt '{prompt_id}'")
            pipeline_steps.append({"prompt_id": prompt.id, "title": prompt.title, "content": prompt.content})
        user_supplied = payload.content.strip()
        first_step_content = pipeline_steps[0]["content"]
        combined_content = f"{user_supplied}\n\n{first_step_content}" if user_supplied else first_step_content
        payload = payload.model_copy(update={"content": combined_content})

    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="Message content cannot be empty")

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
            if pipeline_steps is not None and pipeline is not None:
                task.pipeline_id = pipeline.id
                task.pipeline_name = pipeline.name
                task.pipeline_steps_json = json.dumps(pipeline_steps)
                task.pipeline_step_index = 0
                db.add(task)
                db.commit()
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

    # orchestrator.start_task/followup_task (above) do most of their event
    # processing on separate SessionLocal() instances (see
    # TaskOrchestrator._handle_runtime_event), which is how synchronous
    # runtimes like the mock adapter can run a whole pipeline to completion
    # within this one request. This session's own transaction began its
    # snapshot before any of that happened, so — unlike expire_all(), which
    # only invalidates the ORM's object cache — it would keep reading that
    # stale pre-pipeline snapshot without an explicit commit here to end the
    # transaction and let the next read start a fresh one that can see it.
    db.commit()
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


@app.get("/runtime/usage", response_model=RuntimeUsageResponse)
async def get_runtime_usage(engine: str):
    adapter = _adapter_for_engine(engine)
    # Antigravity's get_usage() is a real ~1-3s subprocess spawn per call --
    # the compose bar and the desktop Task Detail panel can both be polling
    # this at once, so a short cache absorbs a burst of concurrent requests
    # into one actual call instead of one each.
    usage = await _usage_cache.get_or_fetch(engine, adapter.get_usage)
    return RuntimeUsageResponse(engine=engine, usage=usage)


@app.post("/tasks", response_model=TaskDetail)
async def post_task(payload: CreateTaskRequest, db: Session = Depends(get_db)):
    project = get_project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    allowed_models, _ = await _model_catalog_for(payload.engine).list_models()
    _validate_task_model(payload.model, payload.profile, allowed_models)
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
async def get_task_events(
    task_id: str,
    response: Response,
    db: Session = Depends(get_db),
    exclude_types: str | None = Query(default=None),
):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await _reconcile_and_ensure_task_runtime_stream(task, db)
    excluded: set[str] = {t.strip() for t in exclude_types.split(",") if t.strip()} if exclude_types else set()
    # For a long-running task, command_executed/agent_status events are the
    # overwhelming majority of both event count and payload size (measured
    # live: 98% of bytes on a 9655-event task) -- and the frontend already
    # keeps them collapsed behind an "Expand"/"View technical events" toggle
    # by default, so fetching their full bodies before the user ever opens
    # that toggle was pure waste. The excluded count still needs to reach
    # the frontend somehow without changing this endpoint's response shape
    # (a plain list, for backward compatibility with the unfiltered case),
    # so it rides along as a header instead.
    if excluded:
        response.headers["X-Excluded-Event-Count"] = str(count_events(db, task_id, excluded))
        # The excluded types are usually exactly what was most recently
        # happening (a running task's tail is mostly command_executed/
        # agent_status) -- without this, "last activity" would read as
        # stale for as long as the excluded types keep being the newest
        # ones, which is most of the time for an active task.
        latest_at = latest_event_at(db, task_id)
        if latest_at is not None:
            response.headers["X-Latest-Event-At"] = latest_at.isoformat()
    return [serialize_event(item) for item in list_events(db, task_id, exclude_types=excluded or None)]


@app.get("/tasks/{task_id}/diff", response_model=TaskDiff)
async def get_task_diff(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    # A PR/MR's own diff is the authoritative record of what changed,
    # independent of the local task workspace's current state -- once the
    # agent has committed (the normal path once a PR/MR exists), a live
    # `git diff` against that workspace shows nothing, which used to make
    # the diff tab go blank for exactly the tasks that finished cleanly.
    # Falls through to the workspace-based computation below if no PR/MR is
    # known yet, or if fetching its diff fails/comes back empty.
    conv = get_conversation_for_task(db, task_id)
    if conv is not None:
        pr_url = find_latest_pr_or_mr_url([m.content for m in conv.messages if m.content])
        if pr_url is not None:
            pr_diff = await fetch_pr_or_mr_diff(pr_url)
            if pr_diff is not None and pr_diff.files_changed:
                return pr_diff

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
    await _merge_task_pull_request(db, task)
    task = _require_task(get_task(db, task_id))
    return serialize_task_detail(task)


async def _merge_task_pull_request(db: Session, task) -> None:
    """Approving a task also merges the pull request its agent opened.

    Tasks are told to open a PR and explicitly not to merge it themselves
    (see runtime._prompt_with_workspace), so this is what actually gets
    approved work onto the default branch. Records the outcome as a task
    event either way and never raises: the approval itself already
    succeeded by this point, and a merge that can't happen (no PR,
    conflicts, plan-mode task, missing credential) must not retroactively
    fail it -- the event log is where the user sees why.
    """
    if task.execution_mode == "plan" or not task.workspace_path:
        return
    try:
        result = await merge_pull_request_for_branch(task.workspace_path, task.workspace_ref)
    except Exception as exc:  # defensive: helper is already non-raising
        result = MergeResult(False, f"Unexpected error while merging: {exc}")
    append_event(
        db,
        task,
        RuntimeEvent(
            type="agent_status",
            message=result.message,
            payload={
                "source": "pull_request_merge",
                "ok": result.ok,
                "pr_number": result.pr_number,
                "pr_url": result.pr_url,
            },
        ),
    )


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
        _validate_task_model(payload.model, payload.profile, allowed_models)
    add_approval(db, task, "retry", payload.actor)
    try:
        await orchestrator.retry_task(db, task, model_override=payload.model, profile_override=payload.profile)
    except Exception as exc:
        # retry_task moves the task to "starting" before it opens the runtime
        # session; if that open fails, the task would otherwise be stranded in
        # "starting" with no session -- an active status the UI shows as
        # "in progress" forever, and which nothing (not even a restart, see
        # reconcile_active_tasks) can heal, leaving the task un-retryable.
        # POST /tasks already does this on its own start failure; retry has to
        # do the same.
        task = _require_task(get_task(db, task_id))
        set_task_status(db, task, "failed")
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
