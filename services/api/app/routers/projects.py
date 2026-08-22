"""Project CRUD, repository discovery, and a project's task list."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..codex_project_trust import add_project_trust_entry
from ..db import get_db
from ..repo_discovery import FolderSelectionCancelled, RepositoryDiscoveryError, discover_repository
from ..repository import (
    create_project,
    get_project,
    get_project_any,
    list_projects,
    list_tasks,
    serialize_project,
    serialize_task_summary,
    soft_delete_project,
)
from ..schemas import (
    CreateProjectRequest,
    DiscoverProjectRequest,
    DiscoverProjectResponse,
    ProjectSummary,
    TaskSummary,
)

router = APIRouter()


@router.get("/projects", response_model=list[ProjectSummary])
def get_projects(db: Session = Depends(get_db)):
    return [serialize_project(item) for item in list_projects(db)]


@router.post("/projects", response_model=ProjectSummary)
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


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    if get_project_any(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    soft_delete_project(db, project_id)
    return Response(status_code=204)


@router.post("/projects/discover", response_model=DiscoverProjectResponse)
def post_project_discovery(payload: DiscoverProjectRequest | None = None):
    try:
        return discover_repository(payload.path if payload else None)
    except FolderSelectionCancelled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RepositoryDiscoveryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/projects/{project_id}/tasks", response_model=list[TaskSummary])
def get_project_tasks(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_task_summary(item) for item in list_tasks(db, project_id)]
