"""Conversations: the chat surface a task is created from and followed up in.

Also serves the PR/MR cards derived from links mentioned in a conversation.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..pr_info import fetch_pr_or_mr_diff, fetch_pr_or_mr_info, find_all_pr_or_mr_urls
from ..repository import (
    add_conversation_message,
    count_conversations_by_project,
    create_conversation,
    create_task,
    delete_conversation,
    delete_task,
    get_conversation,
    get_project,
    get_project_pipeline,
    get_project_prompt,
    get_task,
    list_conversations,
    serialize_conversation_detail,
    serialize_conversation_summary,
    set_conversation_task_id,
    set_task_status,
)
from ..runtime_registry import model_catalog_for, orchestrator
from ..schemas import (
    AddConversationMessageRequest,
    ConversationDetail,
    ConversationSummary,
    CreateConversationRequest,
    CreateTaskRequest,
    PrInfoResponse,
    TaskDiff,
)
from ..workspace import cleanup_workspace
from .common import safe_runtime_error_detail

router = APIRouter()


@router.get("/conversations", response_model=list[ConversationSummary])
def get_conversations(db: Session = Depends(get_db), preview_count: int | None = Query(default=None)):
    convs = list_conversations(db, preview_count=preview_count)
    return [serialize_conversation_summary(c) for c in convs]


@router.get("/conversations/counts", response_model=dict[str, int])
def get_conversation_counts(db: Session = Depends(get_db)):
    # Paired with GET /conversations?preview_count=N: that response omits
    # conversations past each project's preview cutoff, so the "더보기 (N)"
    # button needs the true per-project total from somewhere else to show
    # its count before the user has actually asked to see the rest.
    counts = count_conversations_by_project(db)
    return {(project_id or "__no_project__"): count for project_id, count in counts.items()}


@router.post("/conversations", response_model=ConversationDetail, status_code=201)
def post_conversation(payload: CreateConversationRequest = CreateConversationRequest(), db: Session = Depends(get_db)):
    conv = create_conversation(db, payload)
    conv_with_messages = get_conversation(db, conv.id)
    return serialize_conversation_detail(conv_with_messages)


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation_detail(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return serialize_conversation_detail(conv)


@router.get("/conversations/{conversation_id}/pr-info", response_model=list[PrInfoResponse])
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


@router.get("/conversations/{conversation_id}/pr-diff", response_model=TaskDiff)
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


@router.delete("/conversations/{conversation_id}", status_code=204)
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


@router.post("/conversations/{conversation_id}/messages", response_model=ConversationDetail, status_code=201)
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
            allowed_models, _ = await model_catalog_for(payload.engine).list_models()
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
                detail = safe_runtime_error_detail("Failed to start Codex session", exc)
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
                        detail = safe_runtime_error_detail("Follow-up failed", exc)
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
                        detail = safe_runtime_error_detail("Failed to restart Codex session", start_exc)
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
