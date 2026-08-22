"""Projects: the repositories Zenbar runs tasks against.

Deletes are soft, so tasks already recorded against a project keep resolving.
"""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..models import Project
from ..schemas import CreateProjectRequest

def create_project(db: Session, payload: CreateProjectRequest) -> Project:
    project = Project(
        name=payload.name,
        repo_path=payload.repo_path,
        default_branch=payload.default_branch,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def list_projects(db: Session) -> list[Project]:
    stmt = select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created_at.desc())
    return list(db.scalars(stmt))


def get_project(db: Session, project_id: str) -> Project | None:
    stmt = select(Project).where(Project.id == project_id, Project.deleted_at.is_(None))
    return db.scalars(stmt).first()


def get_project_any(db: Session, project_id: str) -> Project | None:
    return db.get(Project, project_id)


def soft_delete_project(db: Session, project_id: str) -> None:
    db.execute(
        update(Project)
        .where(Project.id == project_id, Project.deleted_at.is_(None))
        .values(deleted_at=func.current_timestamp())
    )
    db.commit()
