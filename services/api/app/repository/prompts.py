"""A project's saved prompts and the pipelines that chain them.

A pipeline stores an ordered list of prompt *ids*; the content is resolved when
a run starts, and a running task snapshots the resolved steps so editing the
pipeline mid-run cannot change what is executing.
"""

from __future__ import annotations

import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import ProjectPipeline, ProjectPrompt
from ..schemas import (
    CreateProjectPipelineRequest,
    CreateProjectPromptRequest,
    UpdateProjectPipelineRequest,
    UpdateProjectPromptRequest,
)

def list_project_prompts(db: Session, project_id: str) -> list[ProjectPrompt]:
    stmt = (
        select(ProjectPrompt)
        .where(ProjectPrompt.project_id == project_id)
        .order_by(ProjectPrompt.position, ProjectPrompt.created_at)
    )
    return list(db.scalars(stmt))


def get_project_prompt(db: Session, prompt_id: str) -> ProjectPrompt | None:
    return db.get(ProjectPrompt, prompt_id)


def create_project_prompt(db: Session, project_id: str, payload: CreateProjectPromptRequest) -> ProjectPrompt:
    next_position = db.scalar(
        select(func.max(ProjectPrompt.position)).where(ProjectPrompt.project_id == project_id)
    )
    prompt = ProjectPrompt(
        project_id=project_id,
        title=payload.title,
        content=payload.content,
        position=(next_position or 0) + 1,
    )
    db.add(prompt)
    db.commit()
    db.refresh(prompt)
    return prompt


def update_project_prompt(db: Session, prompt: ProjectPrompt, payload: UpdateProjectPromptRequest) -> ProjectPrompt:
    if payload.title is not None:
        prompt.title = payload.title
    if payload.content is not None:
        prompt.content = payload.content
    db.add(prompt)
    db.commit()
    db.refresh(prompt)
    return prompt


def delete_project_prompt(db: Session, prompt_id: str) -> None:
    prompt = db.get(ProjectPrompt, prompt_id)
    if prompt:
        db.delete(prompt)
        db.commit()


def list_project_pipelines(db: Session, project_id: str) -> list[ProjectPipeline]:
    stmt = (
        select(ProjectPipeline)
        .where(ProjectPipeline.project_id == project_id)
        .order_by(ProjectPipeline.created_at)
    )
    return list(db.scalars(stmt))


def get_project_pipeline(db: Session, pipeline_id: str) -> ProjectPipeline | None:
    return db.get(ProjectPipeline, pipeline_id)


def create_project_pipeline(db: Session, project_id: str, payload: CreateProjectPipelineRequest) -> ProjectPipeline:
    pipeline = ProjectPipeline(
        project_id=project_id,
        name=payload.name,
        prompt_ids_json=json.dumps(payload.prompt_ids),
    )
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return pipeline


def update_project_pipeline(db: Session, pipeline: ProjectPipeline, payload: UpdateProjectPipelineRequest) -> ProjectPipeline:
    if payload.name is not None:
        pipeline.name = payload.name
    if payload.prompt_ids is not None:
        pipeline.prompt_ids_json = json.dumps(payload.prompt_ids)
    db.add(pipeline)
    db.commit()
    db.refresh(pipeline)
    return pipeline


def delete_project_pipeline(db: Session, pipeline_id: str) -> None:
    pipeline = db.get(ProjectPipeline, pipeline_id)
    if pipeline:
        db.delete(pipeline)
        db.commit()
