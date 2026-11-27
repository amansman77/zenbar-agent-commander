"""Conversations: the chat surface a task is created from and followed up in.

Also serves the PR/MR cards derived from links mentioned in a conversation.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..attachments import (
    MAX_ATTACHMENT_BYTES,
    MAX_CONVERSATION_ATTACHMENT_BYTES,
    attachment_prompt,
    attachment_root,
    remove_attachment_file,
    validate_attachment_name,
)
from ..pr_info import fetch_pr_or_mr_diff, fetch_pr_or_mr_info, find_all_pr_or_mr_urls
from ..repository import (
    add_conversation_message,
    attach_pipeline,
    count_conversations_by_project,
    create_conversation,
    create_task,
    conversation_attachment_bytes,
    create_attachment,
    delete_attachment,
    delete_conversation,
    get_conversation,
    get_project,
    get_task,
    get_attachment,
    list_conversation_assistant_messages,
    list_conversation_message_page,
    list_conversations,
    list_reviewed_pr_urls,
    mark_conversation_read,
    rename_conversation,
    resolve_pipeline_steps,
    serialize_conversation_detail,
    serialize_conversation_message,
    serialize_conversation_summary,
    set_conversation_task_id,
    set_pr_reviewed,
    set_task_status,
)
from ..runtime_registry import model_catalog_for, orchestrator
from ..schemas import (
    AddConversationMessageRequest,
    ConversationDetail,
    ConversationAttachmentItem,
    ConversationMessageItem,
    ConversationSummary,
    CreateConversationRequest,
    PrInfoResponse,
    SetPrReviewedRequest,
    TaskCreate,
    TaskDiff,
    UpdateConversationRequest,
)
from .common import safe_runtime_error_detail

router = APIRouter()


@router.post("/conversations/{conversation_id}/attachments", response_model=ConversationAttachmentItem, status_code=201)
async def upload_conversation_attachment(
    conversation_id: str, request: Request, name: str = Query(max_length=240), db: Session = Depends(get_db)
):
    if get_conversation(db, conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="파일을 application/octet-stream 형식으로 업로드하세요.")
    try:
        validate_attachment_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    remaining = MAX_CONVERSATION_ATTACHMENT_BYTES - conversation_attachment_bytes(db, conversation_id)
    attachment_id = str(uuid4())
    root = attachment_root()
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    conversation_directory = root / conversation_id
    conversation_directory.mkdir(mode=0o700, exist_ok=True)
    directory = conversation_directory / attachment_id
    directory.mkdir(mode=0o700)
    path = directory / name
    size = 0
    try:
        with path.open("xb") as output:
            path.chmod(0o600)
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_ATTACHMENT_BYTES or size > remaining:
                    raise HTTPException(status_code=413, detail="파일은 10MB, 대화당 첨부파일은 100MB까지 가능합니다.")
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="빈 파일은 첨부할 수 없습니다.")
        try:
            attachment = create_attachment(
                db, attachment_id=attachment_id, conversation_id=conversation_id, name=name, size=size, path=str(path),
                maximum_bytes=MAX_CONVERSATION_ATTACHMENT_BYTES,
            )
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
    except BaseException:
        remove_attachment_file(str(path))
        raise
    return ConversationAttachmentItem(id=attachment.id, name=attachment.name, size=attachment.size)


@router.get("/conversations/{conversation_id}/attachments/{attachment_id}")
def download_conversation_attachment(conversation_id: str, attachment_id: str, db: Session = Depends(get_db)):
    attachment = get_attachment(db, conversation_id, attachment_id)
    if attachment is None or not Path(attachment.path).is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    return FileResponse(
        attachment.path, filename=attachment.name, media_type="application/octet-stream",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )


@router.delete("/conversations/{conversation_id}/attachments/{attachment_id}", status_code=204)
def delete_conversation_attachment(conversation_id: str, attachment_id: str, db: Session = Depends(get_db)):
    attachment = get_attachment(db, conversation_id, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    if attachment.messages:
        raise HTTPException(status_code=409, detail="이미 전송한 첨부파일은 삭제할 수 없습니다.")
    remove_attachment_file(attachment.path)
    delete_attachment(db, attachment)
    return Response(status_code=204)


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
def get_conversation_detail(
    conversation_id: str,
    limit: int | None = Query(default=None, ge=1, le=100),
    before: str | None = Query(default=None, min_length=1),
    after: str | None = None,
    user_turns: bool = False,
    defer_intermediates: bool = False,
    db: Session = Depends(get_db),
):
    if (before is not None or after is not None) and (limit is None or (before is not None and after is not None)):
        raise HTTPException(status_code=422, detail="Specify a limit and at most one message cursor")
    if user_turns and (limit is None or after is not None):
        raise HTTPException(status_code=422, detail="User-turn pages require a limit and cannot use an after cursor")
    conv = get_conversation(db, conversation_id, include_messages=limit is None)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if limit is None:
        return serialize_conversation_detail(conv)
    try:
        messages, has_more = list_conversation_message_page(
            db, conversation_id, limit, before=before, after=after, user_turns=user_turns
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return serialize_conversation_detail(
        conv, messages=messages, has_more_messages=has_more, defer_intermediates=defer_intermediates
    )


@router.get("/conversations/{conversation_id}/intermediate-messages", response_model=list[ConversationMessageItem])
def get_intermediate_messages(
    conversation_id: str,
    first_id: str = Query(min_length=1),
    last_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
):
    try:
        rows = list_conversation_assistant_messages(db, conversation_id, first_id, last_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return [serialize_conversation_message(row) for row in rows]


@router.patch("/conversations/{conversation_id}", response_model=ConversationDetail)
def patch_conversation(
    conversation_id: str, payload: UpdateConversationRequest, metadata_only: bool = False, db: Session = Depends(get_db)
):
    if get_conversation(db, conversation_id, include_messages=False) is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    rename_conversation(db, conversation_id, payload.title)
    conv = get_conversation(db, conversation_id, include_messages=not metadata_only)
    return serialize_conversation_detail(conv, messages=[] if metadata_only else None)


@router.post("/conversations/{conversation_id}/read", status_code=204)
def post_conversation_read(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id, include_messages=False)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    mark_conversation_read(db, conversation_id)
    return Response(status_code=204)


@router.get("/conversations/{conversation_id}/pr-info", response_model=list[PrInfoResponse])
async def get_conversation_pr_info(conversation_id: str, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    texts = [m.content for m in conv.messages if m.content]
    urls = find_all_pr_or_mr_urls(texts)
    if not urls:
        return []
    reviewed_urls = list_reviewed_pr_urls(db, conversation_id)
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
            is_reviewed=info.url in reviewed_urls,
        )
        for info, diff in zip(infos, diffs)
        if info is not None
    ]


@router.put("/conversations/{conversation_id}/pr-reviews", status_code=204)
def put_pr_reviewed(conversation_id: str, payload: SetPrReviewedRequest, db: Session = Depends(get_db)):
    conv = get_conversation(db, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    set_pr_reviewed(db, conversation_id, payload.url, payload.reviewed)
    return Response(status_code=204)


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
    attachment_paths = [item.path for item in conv.attachments]
    if conv.task:
        orchestrator.delete_task(db, conv.task)
    delete_conversation(db, conversation_id)
    for path in attachment_paths:
        remove_attachment_file(path)
    return Response(status_code=204)


@router.post("/conversations/{conversation_id}/messages", response_model=ConversationDetail, status_code=201)
async def post_conversation_message(
    conversation_id: str,
    payload: AddConversationMessageRequest,
    metadata_only: bool = False,
    db: Session = Depends(get_db),
):
    conv = get_conversation(db, conversation_id, include_messages=False)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    attachments = []
    if payload.attachment_ids:
        if payload.role != "user" or len(set(payload.attachment_ids)) != len(payload.attachment_ids):
            raise HTTPException(status_code=400, detail="사용자 메시지에 중복 없이 파일을 첨부하세요.")
        for attachment_id in payload.attachment_ids:
            attachment = get_attachment(db, conversation_id, attachment_id)
            if attachment is None or not Path(attachment.path).is_file():
                raise HTTPException(status_code=404, detail="Attachment not found")
            attachments.append(attachment)
    project = get_project(db, conv.project_id) if conv.project_id and payload.role == "user" else None
    if payload.role == "user":
        if conv.project_id and project is None:
            raise HTTPException(status_code=400, detail="Conversation project is unavailable")
        if conv.task is not None and conv.task.status not in {"completed", "stopped", "failed"}:
            raise HTTPException(status_code=409, detail="진행 중인 작업이 끝난 후 메시지를 전송하세요.")

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
    pipeline_steps: list[dict[str, str]] | None = None
    if payload.role == "user" and payload.pipeline_id and conv.task_id is None:
        if project is None:
            raise HTTPException(status_code=400, detail="Conversation has no associated project")
        try:
            pipeline, pipeline_steps = resolve_pipeline_steps(db, project.id, payload.pipeline_id)
        except ValueError as exc:
            if "not found" in str(exc).lower():
                raise HTTPException(status_code=404, detail="Pipeline not found") from exc
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        user_supplied = payload.content.strip()
        first_step_content = pipeline_steps[0]["content"]
        combined_content = f"{user_supplied}\n\n{first_step_content}" if user_supplied else first_step_content
        payload = payload.model_copy(update={"content": combined_content})

    if not payload.content.strip() and not attachments:
        raise HTTPException(status_code=400, detail="Message content cannot be empty")

    add_conversation_message(db, conversation_id, payload, attachments=attachments)
    runtime_content = attachment_prompt(payload.content, attachments)

    if payload.role == "user":
        conv = get_conversation(db, conversation_id, include_messages=False)
        selected_skill = payload.selected_skill or None
        if conv.task_id is None:
            allowed_models, _ = await model_catalog_for(payload.engine).list_models()
            default_model = allowed_models[0] if allowed_models else "default"
            task_request = TaskCreate(
                project_id=project.id if project else None,
                title=payload.content[:50].strip() or (attachments[0].name if attachments else "Conversation"),
                prompt=runtime_content,
                engine=payload.engine,
                model=payload.model or default_model,
                profile=payload.profile,
                reasoning_effort="medium",
                execution_mode="execute",
                workspace_type="worktree" if project else "directory",
            )
            task = create_task(db, task_request, project_name=project.name if project else None)
            if pipeline_steps is not None and pipeline is not None:
                task = attach_pipeline(db, task, pipeline.id, pipeline.name, pipeline_steps)
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
                    await orchestrator.followup_or_restart_task(
                        db, task, project, runtime_content, selected_skill=selected_skill, model=payload.model,
                        engine=payload.engine, profile=payload.profile,
                    )
                except Exception as exc:
                    # followup_or_restart_task falls back to start_task when
                    # the runtime session is gone, and start_task moves the
                    # task to "starting" before it opens a new one. A failure
                    # in between left the task stranded in an active status
                    # with no session -- see TaskOrchestrator.stop_task for
                    # why that used to be unrecoverable. POST /tasks and retry
                    # already fail their task on a start failure; this path
                    # has to as well, but only when it is the one that moved
                    # the status, or a follow-up that never got that far would
                    # relabel a completed task as failed.
                    stranded = get_task(db, task.id)
                    if stranded is not None and stranded.status == "starting" and not stranded.runtime_session_id:
                        set_task_status(db, stranded, "failed")
                    detail = safe_runtime_error_detail("Follow-up failed", exc)
                    raise HTTPException(status_code=409, detail=detail) from exc

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
    conv = get_conversation(db, conversation_id, include_messages=not metadata_only)
    return serialize_conversation_detail(conv, messages=[] if metadata_only else None)
