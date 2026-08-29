"""Pydantic models for the HTTP API and for runtime<->orchestrator messages.

The request/response half is mirrored by hand in packages/shared/src/index.ts;
changing a shape here means changing it there too.
"""

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
ReasoningEffort = Literal["low", "medium", "high"]
PendingInteractionType = Literal["user_input", "result_approval"]
TurnRole = Literal["user", "assistant"]
RunState = Literal["running", "completed", "failed"]
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


class ProjectPromptItem(BaseModel):
    id: str
    project_id: str
    title: str
    content: str
    position: int
    created_at: datetime
    updated_at: datetime


class CreateProjectPromptRequest(BaseModel):
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)


class UpdateProjectPromptRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    content: str | None = Field(default=None, min_length=1)


class ReorderProjectPromptsRequest(BaseModel):
    # The full, reordered list of the project's prompt ids -- validated in
    # the router as an exact permutation of what's already there (see
    # put_project_prompts_order), not a partial update.
    prompt_ids: list[str]


class ProjectPipelineItem(BaseModel):
    id: str
    project_id: str
    name: str
    prompt_ids: list[str]
    created_at: datetime
    updated_at: datetime


class CreateProjectPipelineRequest(BaseModel):
    name: str = Field(min_length=1)
    prompt_ids: list[str] = Field(min_length=1)


class UpdateProjectPipelineRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    prompt_ids: list[str] | None = Field(default=None, min_length=1)


class DiscoverProjectResponse(BaseModel):
    name: str
    repo_path: str
    default_branch: str
    current_branch: str | None = None
    is_git_repo: bool


class RuntimeModelOption(BaseModel):
    id: str


class RuntimeModelsResponse(BaseModel):
    models: list[RuntimeModelOption]
    source: Literal["runtime", "fallback"]


class RuntimeEngineOption(BaseModel):
    id: str
    label: str


class RuntimeEnginesResponse(BaseModel):
    engines: list[RuntimeEngineOption]
    default_engine: str


class RuntimeProfileOption(BaseModel):
    id: str
    description: str | None = None
    model: str | None = None


class RuntimeProfilesResponse(BaseModel):
    profiles: list[RuntimeProfileOption]


class RuntimeSkill(BaseModel):
    id: str
    name: str
    description: str | None = None


class RuntimeSkillsResponse(BaseModel):
    skills: list[RuntimeSkill]
    source: Literal["runtime", "fallback"]


class RuntimeUsageWindow(BaseModel):
    percent_used: int
    # The CLI reports this as a human-readable label ("Aug 21 at 11:59am
    # (Asia/Seoul)") with no year and no fixed format -- kept as-is rather
    # than parsed into a timestamp, since that would be fragile for little
    # benefit (the UI just needs to display it).
    resets_label: str | None = None
    # ISO 8601, only set when the source actually gives a real timestamp
    # (Codex's RPC does; Antigravity's CLI reset_time already is one) --
    # lets the frontend compute a "N일 M시간 후" countdown instead of just
    # the absolute time. Claude's /usage is free-text prose with no year
    # and relative day names ("resets Thursday 8am"), not reliably
    # parseable, so it's left unset there and the countdown is simply
    # omitted for that engine rather than guessed at.
    resets_at: str | None = None


class RuntimeUsageInfo(BaseModel):
    session: RuntimeUsageWindow | None = None
    week: RuntimeUsageWindow | None = None


class RuntimeUsageResponse(BaseModel):
    engine: str
    usage: RuntimeUsageInfo | None = None


class PrInfoResponse(BaseModel):
    platform: Literal["github", "gitlab"]
    number: int
    title: str
    description: str | None = None
    state: str
    url: str
    source_branch: str | None = None
    target_branch: str | None = None
    author: str | None = None
    merged_at: str | None = None
    # This PR/MR's own changed-file list, so a conversation with several
    # PR/MRs can show each card's files under that card specifically,
    # instead of one flat list with no indication of which PR/MR it came
    # from (the "which card do these files belong to?" gap this fixes).
    diff: TaskDiff | None = None
    # Whether the user has explicitly marked this specific PR/MR reviewed
    # (see ConversationPrReview) -- deliberately not inferred from anything
    # automatic (opening the conversation, viewing the diff tab), since
    # actually having read the code is a judgment call only the user can
    # make, unlike a chat message where opening the conversation IS reading
    # it.
    is_reviewed: bool = False


class SetPrReviewedRequest(BaseModel):
    url: str
    reviewed: bool


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
    engine: str | None = None
    model: str = Field(min_length=1)
    profile: str | None = None
    reasoning_effort: ReasoningEffort = "medium"
    execution_mode: ExecutionMode = "execute"
    workspace_type: WorkspaceType = "worktree"


class TaskApprovalRequest(BaseModel):
    actor: str = "system"
    model: str | None = Field(default=None, min_length=1)
    profile: str | None = Field(default=None, min_length=1)


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


class FollowupTurnRequest(BaseModel):
    content: str = Field(min_length=1)
    # Switches the model for this and subsequent turns, keeping the same
    # session/workspace/history. None keeps whatever the task is already using.
    model: str | None = None


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
    engine: str | None
    model: str | None
    effective_model: str | None
    profile: str | None
    reasoning_effort: ReasoningEffort | None
    workspace_type: WorkspaceType
    workspace_ref: str
    workspace_path: str | None
    runtime_session_id: str | None
    pipeline_id: str | None = None
    pipeline_name: str | None = None
    pipeline_step_index: int | None = None
    pipeline_total_steps: int | None = None
    created_at: datetime
    updated_at: datetime


class TaskDetail(TaskSummary):
    prompt: str
    session_id: str
    turns: list["SessionTurn"] = Field(default_factory=list)
    runs: list["SessionRun"] = Field(default_factory=list)
    project: ProjectSummary
    approvals: list[TaskApprovalResponse]
    latest_diff: TaskDiff
    pending_interaction_type: PendingInteractionType | None = None
    pending_request_id: str | None = None
    pending_request_payload_json: dict[str, Any] | None = None
    pending_questions: list[TaskQuestion] = Field(default_factory=list)


class RuntimeSession(BaseModel):
    session_id: str
    effective_model: str | None = None


class SessionTurn(BaseModel):
    id: str
    session_id: str
    role: TurnRole
    content: str
    created_at: datetime


class SessionRun(BaseModel):
    id: str
    session_id: str
    parent_run_id: str | None = None
    status: RunState
    input: str
    created_at: datetime


class RuntimeStartRequest(BaseModel):
    task_id: str
    title: str
    prompt: str
    engine: str | None = None
    model: str
    profile: str | None = None
    reasoning_effort: ReasoningEffort = "medium"
    repo_path: str
    working_directory: str
    default_branch: str
    execution_mode: ExecutionMode = "execute"
    workspace_type: WorkspaceType
    workspace_ref: str
    selected_skill: str | None = None


class RuntimeEvent(BaseModel):
    type: str
    message: str
    payload: dict[str, Any] | None = None


class TaskCommitRequest(BaseModel):
    actor: str = "system"
    message: str = Field(min_length=1)


class TaskPushRequest(BaseModel):
    actor: str = "system"
    remote: str = "origin"
    set_upstream: bool = True


class TaskGitActionResponse(BaseModel):
    ok: bool
    branch: str | None = None
    remote: str | None = None
    message: str
    output: str | None = None


class ConversationMessageItem(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: datetime


class ConversationSummary(BaseModel):
    id: str
    title: str
    last_message: str | None
    project_id: str | None
    project_name: str | None
    task_id: str | None
    task_status: TaskStatus | None
    updated_at: datetime
    # True when the latest message is from the assistant and arrived after
    # this conversation was last opened (see repository.mark_conversation_read
    # and serialize_conversation_summary for the exact rule).
    is_unread: bool


class ConversationDetail(BaseModel):
    id: str
    title: str
    project_id: str | None
    project_name: str | None
    task_id: str | None
    task_status: TaskStatus | None
    task_workspace_ref: str | None
    task_base_branch: str | None
    task_model: str | None
    task_profile: str | None
    task_engine: str | None
    task_pipeline_id: str | None = None
    task_pipeline_name: str | None = None
    task_pipeline_step_index: int | None = None
    task_pipeline_total_steps: int | None = None
    messages: list[ConversationMessageItem]
    created_at: datetime
    updated_at: datetime


class CreateConversationRequest(BaseModel):
    title: str = "New Conversation"
    project_id: str | None = None


class AddConversationMessageRequest(BaseModel):
    content: str = ""
    role: str = "user"
    selected_skill: str | None = None
    engine: str | None = None
    model: str | None = None
    profile: str | None = None
    pipeline_id: str | None = None


class FsBrowseEntry(BaseModel):
    name: str
    path: str


class FsBrowseResponse(BaseModel):
    path: str
    parent: str | None
    entries: list[FsBrowseEntry]
