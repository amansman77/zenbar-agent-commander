from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


TaskStatus = Literal[
    "queued",
    "starting",
    "running",
    "waiting_user_input",
    "waiting_result_approval",
    "stopped",
    "failed",
    "completed",
]
WorkspaceType = Literal["branch", "worktree"]
ExecutionMode = Literal["execute", "plan"]
PendingInteractionType = Literal["user_input", "result_approval"]
EventType = Literal[
    "agent_status",
    "file_changed",
    "command_executed",
    "diff_generated",
    "test_result",
    "user_input_requested",
    "user_input_submitted",
    "result_approval_requested",
    "result_approval_granted",
    "plan_updated",
    "plan_delta",
    "completed",
    "failed",
    "stopped",
]


class CreateProjectRequest(BaseModel):
    name: str
    repo_path: str
    default_branch: str = "main"


class DiscoverProjectRequest(BaseModel):
    path: str | None = None


class DiscoverProjectResponse(BaseModel):
    name: str
    repo_path: str
    default_branch: str
    current_branch: str | None = None
    is_git_repo: bool


class ProjectSummary(BaseModel):
    id: str
    name: str
    repo_path: str
    default_branch: str
    created_at: datetime


class CreateTaskRequest(BaseModel):
    project_id: str
    title: str
    prompt: str
    execution_mode: ExecutionMode = "execute"
    workspace_type: WorkspaceType = "branch"


class TaskApprovalRequest(BaseModel):
    actor: str = "system"


class TaskApprovalResponse(BaseModel):
    action: Literal["approve", "stop", "retry"]
    actor: str
    created_at: datetime


class TaskQuestionOption(BaseModel):
    label: str
    description: str


class TaskQuestion(BaseModel):
    id: str
    header: str
    question: str
    is_other: bool = False
    is_secret: bool = False
    options: list[TaskQuestionOption] | None = None


class RespondTaskRequest(BaseModel):
    actor: str = "system"
    answers: dict[str, list[str]]


class TaskDiff(BaseModel):
    files_changed: list[str] = Field(default_factory=list)
    summary: str = ""
    raw_diff: str | None = None


class TaskEventResponse(BaseModel):
    id: str
    task_id: str
    seq: int
    type: EventType
    message: str
    payload_json: dict[str, Any] | None = None
    created_at: datetime


class TaskSummary(BaseModel):
    id: str
    project_id: str
    title: str
    status: TaskStatus
    execution_mode: ExecutionMode
    workspace_type: WorkspaceType
    workspace_ref: str
    workspace_path: str | None
    runtime_session_id: str | None
    created_at: datetime
    updated_at: datetime


class TaskDetail(TaskSummary):
    prompt: str
    project: ProjectSummary
    approvals: list[TaskApprovalResponse]
    latest_diff: TaskDiff
    pending_interaction_type: PendingInteractionType | None = None
    pending_request_id: str | None = None
    pending_request_payload_json: dict[str, Any] | None = None
    pending_questions: list[TaskQuestion] = Field(default_factory=list)


class RuntimeSession(BaseModel):
    session_id: str


class RuntimeStartRequest(BaseModel):
    task_id: str
    title: str
    prompt: str
    repo_path: str
    working_directory: str
    default_branch: str
    execution_mode: ExecutionMode = "execute"
    workspace_type: WorkspaceType
    workspace_ref: str


class RuntimeEvent(BaseModel):
    type: str
    message: str
    payload: dict[str, Any] | None = None
