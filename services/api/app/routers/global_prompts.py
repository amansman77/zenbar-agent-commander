"""Saved prompts not scoped to any project -- see models.GlobalPrompt's own
docstring for why this is a separate table/router rather than a nullable
project_id on ProjectPrompt.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..repository import (
    create_global_prompt,
    delete_global_prompt,
    get_global_prompt,
    list_global_prompts,
    reorder_global_prompts,
    serialize_global_prompt,
    update_global_prompt,
)
from ..schemas import (
    CreateGlobalPromptRequest,
    GlobalPromptItem,
    ReorderGlobalPromptsRequest,
    UpdateGlobalPromptRequest,
)

router = APIRouter()


@router.get("/prompts", response_model=list[GlobalPromptItem])
def get_global_prompts(db: Session = Depends(get_db)):
    return [serialize_global_prompt(item) for item in list_global_prompts(db)]


@router.post("/prompts", response_model=GlobalPromptItem, status_code=201)
def post_global_prompt(payload: CreateGlobalPromptRequest, db: Session = Depends(get_db)):
    return serialize_global_prompt(create_global_prompt(db, payload))


@router.put("/prompts/order", response_model=list[GlobalPromptItem])
def put_global_prompts_order(payload: ReorderGlobalPromptsRequest, db: Session = Depends(get_db)):
    existing_ids = {item.id for item in list_global_prompts(db)}
    # Same exact-permutation contract as put_project_prompts_order's own
    # comment: a partial or mismatched list would silently leave some
    # prompts' positions untouched.
    if set(payload.prompt_ids) != existing_ids or len(payload.prompt_ids) != len(existing_ids):
        raise HTTPException(status_code=400, detail="prompt_ids must be exactly the current global prompts, reordered")
    return [serialize_global_prompt(item) for item in reorder_global_prompts(db, payload.prompt_ids)]


@router.patch("/prompts/{prompt_id}", response_model=GlobalPromptItem)
def patch_global_prompt(prompt_id: str, payload: UpdateGlobalPromptRequest, db: Session = Depends(get_db)):
    prompt = get_global_prompt(db, prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return serialize_global_prompt(update_global_prompt(db, prompt, payload))


@router.delete("/prompts/{prompt_id}", status_code=204)
def delete_global_prompt_endpoint(prompt_id: str, db: Session = Depends(get_db)):
    prompt = get_global_prompt(db, prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    delete_global_prompt(db, prompt_id)
    return Response(status_code=204)
