"""Saved prompts and prompt pipelines belonging to a project."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..repository import (
    create_project_pipeline,
    create_project_prompt,
    delete_project_pipeline,
    delete_project_prompt,
    get_project,
    get_project_pipeline,
    get_project_prompt,
    list_project_pipelines,
    list_project_prompts,
    serialize_project_pipeline,
    serialize_project_prompt,
    update_project_pipeline,
    update_project_prompt,
)
from ..schemas import (
    CreateProjectPipelineRequest,
    CreateProjectPromptRequest,
    ProjectPipelineItem,
    ProjectPromptItem,
    UpdateProjectPipelineRequest,
    UpdateProjectPromptRequest,
)

router = APIRouter()


@router.get("/projects/{project_id}/prompts", response_model=list[ProjectPromptItem])
def get_project_prompts(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_project_prompt(item) for item in list_project_prompts(db, project_id)]


@router.post("/projects/{project_id}/prompts", response_model=ProjectPromptItem, status_code=201)
def post_project_prompt(project_id: str, payload: CreateProjectPromptRequest, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return serialize_project_prompt(create_project_prompt(db, project_id, payload))


@router.patch("/projects/{project_id}/prompts/{prompt_id}", response_model=ProjectPromptItem)
def patch_project_prompt(
    project_id: str, prompt_id: str, payload: UpdateProjectPromptRequest, db: Session = Depends(get_db)
):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    prompt = get_project_prompt(db, prompt_id)
    if prompt is None or prompt.project_id != project_id:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return serialize_project_prompt(update_project_prompt(db, prompt, payload))


@router.delete("/projects/{project_id}/prompts/{prompt_id}", status_code=204)
def delete_project_prompt_endpoint(project_id: str, prompt_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    prompt = get_project_prompt(db, prompt_id)
    if prompt is None or prompt.project_id != project_id:
        raise HTTPException(status_code=404, detail="Prompt not found")
    delete_project_prompt(db, prompt_id)
    return Response(status_code=204)


def validate_pipeline_prompt_ids(db: Session, project_id: str, prompt_ids: list[str]) -> None:
    for prompt_id in prompt_ids:
        prompt = get_project_prompt(db, prompt_id)
        if prompt is None or prompt.project_id != project_id:
            raise HTTPException(status_code=400, detail=f"Prompt '{prompt_id}' not found in this project")


@router.get("/projects/{project_id}/pipelines", response_model=list[ProjectPipelineItem])
def get_project_pipelines(project_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return [serialize_project_pipeline(item) for item in list_project_pipelines(db, project_id)]


@router.post("/projects/{project_id}/pipelines", response_model=ProjectPipelineItem, status_code=201)
def post_project_pipeline(project_id: str, payload: CreateProjectPipelineRequest, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    validate_pipeline_prompt_ids(db, project_id, payload.prompt_ids)
    return serialize_project_pipeline(create_project_pipeline(db, project_id, payload))


@router.patch("/projects/{project_id}/pipelines/{pipeline_id}", response_model=ProjectPipelineItem)
def patch_project_pipeline(
    project_id: str, pipeline_id: str, payload: UpdateProjectPipelineRequest, db: Session = Depends(get_db)
):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    pipeline = get_project_pipeline(db, pipeline_id)
    if pipeline is None or pipeline.project_id != project_id:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    if payload.prompt_ids is not None:
        validate_pipeline_prompt_ids(db, project_id, payload.prompt_ids)
    return serialize_project_pipeline(update_project_pipeline(db, pipeline, payload))


@router.delete("/projects/{project_id}/pipelines/{pipeline_id}", status_code=204)
def delete_project_pipeline_endpoint(project_id: str, pipeline_id: str, db: Session = Depends(get_db)):
    if get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    pipeline = get_project_pipeline(db, pipeline_id)
    if pipeline is None or pipeline.project_id != project_id:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    delete_project_pipeline(db, pipeline_id)
    return Response(status_code=204)
