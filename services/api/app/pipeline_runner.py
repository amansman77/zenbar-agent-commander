"""Pipeline runner: automatic advancement of chained prompt pipelines.

Advances a pipeline task from one step to the next as follow-up turns in the
same session without requiring per-step human approval.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from .models import Task
from .repository import (
    add_conversation_message_for_task,
    append_event,
    set_task_pipeline_step,
)
from .schemas import RuntimeEvent

if TYPE_CHECKING:
    from .service import TaskOrchestrator


async def advance_pipeline_if_needed(orchestrator: TaskOrchestrator, db: Session, task: Task) -> Task:
    """Prompt pipelines run fully automatically (no per-step human
    approval, per the chosen design): once a pipeline task's current
    step is done, advance to the next one immediately as a follow-up
    turn in the same session. A step failing (status becomes "failed")
    is simply not handled here, so the pipeline naturally stops -- there
    is no "resume" path, matching "실패하면 파이프라인 중단".

    A step being "done" means either waiting_result_approval (the
    runtime paused mid-turn to ask permission for a specific file edit
    or command -- see item/fileChange/requestApproval in runtime/app_server.py) or
    already completed outright. Both are real, common outcomes: the App
    Server only requests a mid-turn approval when its own approval
    policy decides one particular action needs it, which most turns
    never trigger -- confirmed live against a real Codex pipeline task
    that ran a full turn and reported turn/completed without a single
    approval request anywhere in its ~450 events. The pipeline used to
    only advance on waiting_result_approval, so real tasks that never
    happened to hit that state (the common case) silently stalled after
    step 1, without ever explicitly failing.
    """
    if not task.pipeline_id or task.status not in {"waiting_result_approval", "completed"}:
        return task
    steps = json.loads(task.pipeline_steps_json or "[]")
    current_index = task.pipeline_step_index if task.pipeline_step_index is not None else 0
    next_index = current_index + 1

    if task.status == "waiting_result_approval":
        try:
            task = await orchestrator.approve_task(db, task)
        except Exception as exc:
            append_event(
                db,
                task,
                RuntimeEvent(
                    type="failed",
                    message=f"Pipeline '{task.pipeline_name}' stopped: could not auto-approve step {current_index + 1}/{len(steps)}.",
                    payload={"reason": "pipeline_auto_approve_failed", "error": str(exc)[:500]},
                ),
            )
            return orchestrator._require_task(db, task.id, "pipeline auto-approve failure")
        # approve_task's own event cascade can itself route back through
        # this very method for a nested "completed" event before this
        # call resumes (confirmed live: MockRuntimeAdapter.approve_task
        # appends its own "completed" event, and a real Codex approval
        # grant can just as well let the turn finish outright) -- if
        # that nested call already advanced past this step, sending the
        # next step's prompt again here would duplicate it.
        task = orchestrator._require_task(db, task.id, "pipeline re-check after approval")
        already_advanced = (task.pipeline_step_index if task.pipeline_step_index is not None else 0) != current_index
        if already_advanced:
            return task
    # else: already "completed" -- the turn simply finished without the
    # runtime ever pausing for a per-action approval, so there is
    # nothing to grant; go straight to advancing.

    if next_index >= len(steps):
        # Last step is done (approved or already completed) -- pipeline
        # finished successfully.
        return task

    next_step = steps[next_index]
    try:
        task = set_task_pipeline_step(db, task, next_index)
        add_conversation_message_for_task(db, task.id, "user", next_step["content"])
        task = await orchestrator.followup_task(db, task, next_step["content"])
    except Exception as exc:
        append_event(
            db,
            task,
            RuntimeEvent(
                type="failed",
                message=f"Pipeline '{task.pipeline_name}' stopped: could not start step {next_index + 1}/{len(steps)}.",
                payload={"reason": "pipeline_followup_failed", "error": str(exc)[:500]},
            ),
        )
        return orchestrator._require_task(db, task.id, "pipeline followup failure")
    return task
