"""Task lifecycle: create, inspect, approve/respond/stop/retry, commit/push,
follow-up turns, and the SSE event stream.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..github_pr import MergeResult, merge_pull_request_for_branch
from ..pr_info import fetch_pr_or_mr_diff, find_latest_pr_or_mr_url
from ..repository import (
    add_approval,
    append_event,
    can_approve,
    can_retry,
    can_stop,
    count_events,
    create_task,
    delete_task,
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
    RuntimeEvent,
    TaskApprovalRequest,
    TaskCommitRequest,
    TaskDetail,
    TaskDiff,
    TaskEventResponse,
    TaskGitActionResponse,
    TaskPushRequest,
)
from ..service import stream_task_events
from ..workspace import cleanup_workspace
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
    repo_path = task.project.repo_path if task.project else None
    cleanup_workspace(task.workspace_path, task.workspace_type, repo_path)
    delete_task(db, task_id)
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
        await orchestrator.approve_task(db, task)
    except Exception as exc:
        detail = safe_runtime_error_detail("Approval failed", exc)
        raise HTTPException(status_code=409, detail=detail) from exc
    task = require_task(get_task(db, task_id))
    await merge_task_pull_request(db, task)
    task = require_task(get_task(db, task_id))
    return serialize_task_detail(task)


async def merge_task_pull_request(db: Session, task) -> None:
    """Approving a task also merges the pull request its agent opened.

    Tasks are told to open a PR and explicitly not to merge it themselves
    (see _prompt_with_workspace in runtime/base.py), so this is what
    actually gets approved work onto the default branch. Records the
    outcome as a task event either way and never raises: the approval
    itself already succeeded by this point, and a merge that can't happen
    (no PR, conflicts, plan-mode task, missing credential) must not
    retroactively fail it -- the event log is where the user sees why.
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
        await orchestrator.followup_task(db, task, content)
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
