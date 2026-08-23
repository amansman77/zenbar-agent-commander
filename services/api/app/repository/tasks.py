"""Tasks and their runs: creation, lookup, status transitions, turns.

Also the can_approve/can_stop/can_retry predicates the routers use to decide
whether a requested transition is legal.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import Task, TaskRun, TaskTurn
from ..schemas import CreateTaskRequest
from .naming import build_workspace_ref

def create_task(db: Session, payload: CreateTaskRequest, project_name: str | None = None) -> Task:
    task = Task(
        project_id=payload.project_id,
        title=payload.title,
        prompt=payload.prompt,
        execution_mode=payload.execution_mode,
        engine=payload.engine,
        model=payload.model,
        profile=payload.profile,
        reasoning_effort=payload.reasoning_effort,
        workspace_type=payload.workspace_type,
        workspace_ref=build_workspace_ref(payload.title, project_name),
        workspace_path=None,
        status="queued",
    )
    db.add(task)
    db.commit()
    created = get_task(db, task.id)
    if created is None:
        raise RuntimeError("Task creation failed")
    create_turn(db, created, role="user", content=payload.prompt)
    return get_task(db, task.id)


def list_tasks(db: Session, project_id: str) -> list[Task]:
    return list(db.scalars(select(Task).where(Task.project_id == project_id).order_by(Task.created_at.desc())))


def get_task(db: Session, task_id: str) -> Task | None:
    stmt = (
        select(Task)
        .where(Task.id == task_id)
        .options(
            selectinload(Task.project),
            selectinload(Task.approvals),
            selectinload(Task.events),
            selectinload(Task.turns),
            selectinload(Task.runs),
        )
        # Sessions here are long-lived across several commits within a single
        # request (e.g. TaskOrchestrator.followup_task commits a new turn,
        # event, and run in sequence before the endpoint re-fetches the task
        # to serialize the response). Since expire_on_commit=False, a
        # relationship collection already loaded earlier in the same Session
        # would otherwise be treated as "populated" and selectinload would
        # skip reloading it, silently returning stale data (e.g. a `runs`
        # list missing the run created moments ago). populate_existing forces
        # every eager-loaded attribute above to be refreshed from this query.
        .execution_options(populate_existing=True)
    )
    return db.scalars(stmt).first()


def delete_task(db: Session, task_id: str) -> None:
    task = db.get(Task, task_id)
    if task:
        db.delete(task)
        db.commit()


def session_id_for_task(task: Task) -> str:
    return task.id


def get_task_by_session_id(db: Session, session_id: str) -> Task | None:
    return get_task(db, session_id)


def set_task_pipeline_step(db: Session, task: Task, step_index: int) -> Task:
    task.pipeline_step_index = step_index
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def create_turn(db: Session, task: Task, role: str, content: str) -> TaskTurn:
    turn = TaskTurn(
        session_id=session_id_for_task(task),
        task_id=task.id,
        role=role,
        content=content,
    )
    db.add(turn)
    db.commit()
    db.refresh(turn)
    return turn


def list_turns(db: Session, task_id: str) -> list[TaskTurn]:
    stmt = select(TaskTurn).where(TaskTurn.task_id == task_id).order_by(TaskTurn.created_at.asc())
    return list(db.scalars(stmt))


def get_latest_run(db: Session, task_id: str) -> TaskRun | None:
    stmt = select(TaskRun).where(TaskRun.task_id == task_id).order_by(TaskRun.created_at.desc())
    return db.scalars(stmt).first()


def create_run(db: Session, task: Task, input_text: str, parent_run_id: str | None = None) -> TaskRun:
    run = TaskRun(
        session_id=session_id_for_task(task),
        task_id=task.id,
        parent_run_id=parent_run_id,
        status="running",
        input=input_text,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def update_latest_run_status(db: Session, task: Task, task_status: str) -> None:
    latest = get_latest_run(db, task.id)
    if latest is None:
        return
    if task_status == "completed":
        latest.status = "completed"
    elif task_status in {"failed", "stopped"}:
        latest.status = "failed"
    else:
        latest.status = "running"
    db.add(latest)


def set_task_status(
    db: Session,
    task: Task,
    status: str,
    runtime_session_id: str | None = None,
    effective_model: str | None = None,
) -> Task:
    task.status = status
    if runtime_session_id is not None:
        task.runtime_session_id = runtime_session_id
    if effective_model is not None:
        task.effective_model = effective_model
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def clear_runtime_session(db: Session, task: Task, status: str = "failed") -> Task:
    task.status = status
    task.runtime_session_id = None
    task.pending_interaction_type = None
    task.pending_request_id = None
    task.pending_request_payload_json = None
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def set_task_workspace(db: Session, task: Task, workspace_path: str) -> Task:
    task.workspace_path = workspace_path
    db.add(task)
    db.commit()
    return get_task(db, task.id)


def can_approve(status: str) -> bool:
    return status == "waiting_result_approval"


def can_stop(status: str) -> bool:
    return status not in {"completed", "failed", "stopped"}


def can_retry(status: str) -> bool:
    return status in {"failed", "stopped", "completed"}
