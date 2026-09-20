"""Task lifecycle: create, inspect, approve/respond/stop/retry, commit/push,
follow-up turns, and the SSE event stream.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..pr_info import fetch_pr_or_mr_diff, find_latest_pr_or_mr_url
from ..repository import (
    add_approval,
    can_approve,
    can_retry,
    can_stop,
    count_events,
    create_task,
    get_conversation_for_task,
    get_project,
    get_task,
    get_task_by_session_id,
    latest_event_at,
    list_events,
    serialize_diff,
    serialize_event,
    serialize_task_detail,
    set_task_status,
)
from ..runtime_registry import model_catalog_for, orchestrator, validate_task_model
from ..schemas import (
    CreateTaskRequest,
    FollowupTurnRequest,
    RespondTaskRequest,
    TaskApprovalRequest,
    TaskCommitRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskGitActionResponse,
    TaskPushRequest,
)
from ..service import stream_task_events
from .common import (
    assert_actionable,
    assert_transition,
    reconcile_and_ensure_task_runtime_stream,
    require_task,
    safe_runtime_error_detail,
)

router = APIRouter()


@router.post("/tasks", response_model=TaskDetail)
async def post_task(payload: CreateTaskRequest, db: Session = Depends(get_db)):
    project = get_project(db, payload.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    allowed_models, _ = await model_catalog_for(payload.engine).list_models()
    validate_task_model(payload.model, payload.profile, allowed_models)
    task = require_task(get_task(db, create_task(db, payload, project_name=project.name).id))
    try:
        task = await orchestrator.start_task(db, task, project)
    except Exception as exc:
        task = set_task_status(db, task, "failed")
        detail = safe_runtime_error_detail("Failed to start Codex App Server session", exc)
        raise HTTPException(status_code=502, detail=detail) from exc
    task = require_task(get_task(db, task.id))
    return serialize_task_detail(task)


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task_endpoint(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    orchestrator.delete_task(db, task)
    return Response(status_code=204)


@router.get("/tasks/{task_id}", response_model=TaskDetail)
async def get_task_detail(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await reconcile_and_ensure_task_runtime_stream(task, db)
    return serialize_task_detail(task)


@router.get("/tasks/{task_id}/events", response_model=list[TaskEventResponse])
async def get_task_events(
    task_id: str,
    response: Response,
    db: Session = Depends(get_db),
    exclude_types: str | None = Query(default=None),
):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await reconcile_and_ensure_task_runtime_stream(task, db)
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


@router.get("/tasks/{task_id}/diff", response_model=TaskDiff)
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

    task = await reconcile_and_ensure_task_runtime_stream(task, db)
    task = await orchestrator.refresh_diff(db, task)
    return serialize_diff(task)


@router.post("/tasks/{task_id}/approve", response_model=TaskDetail)
async def approve_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    assert_actionable(task)
    assert_transition(can_approve(task.status), f"Task cannot be approved from status '{task.status}'")
    add_approval(db, task, "approve", payload.actor)
    try:
        task = await orchestrator.approve_task(db, task, merge_pr=True)
    except Exception as exc:
        detail = safe_runtime_error_detail("Approval failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    return serialize_task_detail(task)


# Back-compat alias: domain merge logic now lives on TaskOrchestrator
merge_task_pull_request = orchestrator.merge_task_pull_request


@router.post("/tasks/{task_id}/respond", response_model=TaskDetail)
async def respond_task(task_id: str, payload: RespondTaskRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    assert_actionable(task)
    assert_transition(task.status == "waiting_user_input", f"Task cannot accept user input from status '{task.status}'")
    try:
        await orchestrator.respond_task(db, task, payload)
    except Exception as exc:
        detail = safe_runtime_error_detail("Response failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@router.post("/tasks/{task_id}/stop", response_model=TaskDetail)
async def stop_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    assert_actionable(task)
    assert_transition(can_stop(task.status), f"Task cannot be stopped from status '{task.status}'")
    add_approval(db, task, "stop", payload.actor)
    try:
        await orchestrator.stop_task(db, task)
    except Exception as exc:
        detail = safe_runtime_error_detail("Stop failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@router.post("/tasks/{task_id}/retry", response_model=TaskDetail)
async def retry_task(task_id: str, payload: TaskApprovalRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    assert_transition(can_retry(task.status), f"Task cannot be retried from status '{task.status}'")
    if payload.model:
        allowed_models, _ = await model_catalog_for(task.engine).list_models()
        validate_task_model(payload.model, payload.profile, allowed_models)
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
        task = require_task(get_task(db, task_id))
        set_task_status(db, task, "failed")
        detail = safe_runtime_error_detail("Retry failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = require_task(get_task(db, task_id))
    return serialize_task_detail(task)


@router.post("/tasks/{task_id}/commit", response_model=TaskGitActionResponse)
async def commit_task_workspace(task_id: str, payload: TaskCommitRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    try:
        return await orchestrator.commit_workspace(db, task, payload)
    except Exception as exc:
        detail = safe_runtime_error_detail("Commit failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc


@router.post("/tasks/{task_id}/push", response_model=TaskGitActionResponse)
async def push_task_workspace(task_id: str, payload: TaskPushRequest, db: Session = Depends(get_db)):
    task = require_task(get_task(db, task_id))
    try:
        return await orchestrator.push_workspace(db, task, payload)
    except Exception as exc:
        detail = safe_runtime_error_detail("Push failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc


@router.post("/sessions/{session_id}/turns", response_model=TaskDetail)
async def post_session_turn(session_id: str, payload: FollowupTurnRequest, db: Session = Depends(get_db)):
    task = get_task_by_session_id(db, session_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Session not found")
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Follow-up content cannot be empty")
    try:
        await orchestrator.followup_task(db, task, content, model=payload.model)
    except Exception as exc:
        detail = safe_runtime_error_detail("Follow-up failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = require_task(get_task(db, task.id))
    return serialize_task_detail(task)


@router.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str, db: Session = Depends(get_db)):
    task = get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task = await reconcile_and_ensure_task_runtime_stream(task, db)
    return StreamingResponse(stream_task_events(task_id), media_type="text/event-stream")


# Agents report screenshot/evidence images by just mentioning a file path in
# their plain-text response (e.g. "증거: `docs/evidence/issue-86/foo.png`"),
# not as a URL or markdown image -- there's nothing else to fetch that path
# from, since it only ever existed on this machine's disk (in the task's
# worktree, or occasionally a scratch /tmp path the agent chose itself).
# Deliberately narrow: only these extensions are servable -- this is a
# preview endpoint for what an agent produced, not a general file read.
_WORKSPACE_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
# HTML previews (agents emit self-contained design prototypes) are served too,
# but under two extra rules the images don't need, because HTML *executes*:
# it must live inside the task's own workspace (see below), and it goes out
# with the sandbox headers in _HTML_PREVIEW_HEADERS.
_WORKSPACE_HTML_EXTENSIONS = {".html", ".htm"}

# `sandbox allow-scripts` gives the response an opaque origin while still
# running its scripts: the prototypes are useless without JS (they build their
# own DOM), but agent-authored JS must not reach the dashboard's origin, where
# it could read localStorage or call the API with the user's token. Everything
# else is denied outright, so a preview cannot phone home either -- with
# `default-src 'none'`, fetch/XHR/WebSocket are blocked, which is the part the
# iframe sandbox attribute alone would not give us. The header matters beyond
# the iframe: it is what still protects the user if the preview is opened
# directly in a tab, where no sandbox attribute applies.
_HTML_PREVIEW_HEADERS = {
    "Content-Security-Policy": (
        "sandbox allow-scripts; default-src 'none'; "
        "style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
        "img-src data: blob:; font-src data:"
    ),
    "X-Content-Type-Options": "nosniff",
}


@router.get("/tasks/{task_id}/workspace-file")
def get_task_workspace_file(task_id: str, path: str, db: Session = Depends(get_db)):
    from mimetypes import guess_type
    from pathlib import Path

    from fastapi.responses import FileResponse

    task = require_task(get_task(db, task_id))
    suffix = Path(path).suffix.lower()
    is_html = suffix in _WORKSPACE_HTML_EXTENSIONS
    if suffix not in _WORKSPACE_IMAGE_EXTENSIONS and not is_html:
        raise HTTPException(
            status_code=400, detail="Only image and HTML files can be served from this endpoint"
        )

    workspace_root = Path(task.workspace_path).resolve() if task.workspace_path else None

    requested = Path(path)
    if requested.is_absolute():
        # Same trust level as /fs/browse (also unauthenticated-beyond-the-
        # app-token, also reads whatever this local user can read) -- the
        # extension allowlist above is what keeps this endpoint narrow, not
        # path scoping, since an agent-chosen /tmp path has no workspace to
        # be relative to.
        resolved = requested.resolve()
    else:
        if workspace_root is None:
            raise HTTPException(status_code=404, detail="Task has no workspace")
        resolved = (workspace_root / requested).resolve()
        if not (resolved == workspace_root or workspace_root in resolved.parents):
            raise HTTPException(status_code=400, detail="Path escapes the task workspace")

    # An absolute path is fine for an image (it is inert), but HTML is code:
    # "render any .html on this disk" is a much larger blast radius than "view
    # any .png", so previews are confined to the workspace the task produced
    # them in, whichever form the path arrived as.
    if is_html:
        if workspace_root is None:
            raise HTTPException(status_code=404, detail="Task has no workspace")
        if not (resolved == workspace_root or workspace_root in resolved.parents):
            raise HTTPException(
                status_code=400, detail="HTML previews must live inside the task workspace"
            )

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    media_type = guess_type(str(resolved))[0] or "application/octet-stream"
    if is_html:
        return FileResponse(resolved, media_type="text/html", headers=_HTML_PREVIEW_HEADERS)
    return FileResponse(resolved, media_type=media_type)
