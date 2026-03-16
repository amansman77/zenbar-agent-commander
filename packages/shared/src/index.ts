export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_user_input"
  | "waiting_result_approval"
  | "stopped"
  | "failed"
  | "completed";

export type WorkspaceType = "branch" | "worktree";
export type ExecutionMode = "execute" | "plan";
export type ReasoningEffort = "low" | "medium" | "high";

export type EventType =
  | "agent_status"
  | "file_changed"
  | "command_executed"
  | "diff_generated"
  | "test_result"
  | "user_input_requested"
  | "user_input_submitted"
  | "result_approval_requested"
  | "result_approval_granted"
  | "plan_updated"
  | "plan_delta"
  | "completed"
  | "failed"
  | "stopped";

export type PendingInteractionType = "user_input" | "result_approval";

export interface ProjectSummary {
  id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  created_at: string;
}

export interface DiscoverProjectRequest {
  path?: string;
}

export interface DiscoverProjectResponse {
  name: string;
  repo_path: string;
  default_branch: string;
  current_branch: string | null;
  is_git_repo: boolean;
}

export interface RuntimeModelOption {
  id: string;
}

export interface ListRuntimeModelsResponse {
  models: RuntimeModelOption[];
  source: "runtime" | "fallback";
}

export interface TaskSummary {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  execution_mode: ExecutionMode;
  model: string | null;
  effective_model: string | null;
  reasoning_effort: ReasoningEffort | null;
  workspace_type: WorkspaceType;
  workspace_ref: string;
  workspace_path: string | null;
  runtime_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: string;
  task_id: string;
  seq: number;
  type: EventType;
  message: string;
  payload_json: Record<string, unknown> | null;
  created_at: string;
}

export interface TaskDiff {
  files_changed: string[];
  summary: string;
  raw_diff?: string | null;
}

export interface TaskApproval {
  action: "approve" | "stop" | "retry";
  actor: string;
  created_at: string;
}

export interface TaskQuestionOption {
  label: string;
  description: string;
}

export interface TaskQuestion {
  id: string;
  header: string;
  question: string;
  is_other: boolean;
  is_secret: boolean;
  options: TaskQuestionOption[] | null;
}

export interface TaskDetail extends TaskSummary {
  prompt: string;
  project: ProjectSummary;
  approvals: TaskApproval[];
  latest_diff: TaskDiff;
  pending_interaction_type: PendingInteractionType | null;
  pending_request_id: string | null;
  pending_request_payload_json: Record<string, unknown> | null;
  pending_questions: TaskQuestion[];
}

export interface CreateProjectRequest {
  name: string;
  repo_path: string;
  default_branch: string;
}

export interface CreateTaskRequest {
  project_id: string;
  title: string;
  prompt: string;
  model: string;
  reasoning_effort?: ReasoningEffort;
  execution_mode?: ExecutionMode;
  workspace_type?: WorkspaceType;
}

export interface ApproveTaskRequest {
  actor?: string;
  model?: string;
}

export interface RespondTaskRequest {
  actor?: string;
  answers: Record<string, string[]>;
}

export interface CommitTaskRequest {
  actor?: string;
  message: string;
}

export interface PushTaskRequest {
  actor?: string;
  remote?: string;
  set_upstream?: boolean;
}

export interface TaskGitActionResult {
  ok: boolean;
  branch: string | null;
  remote: string | null;
  message: string;
  output: string | null;
}
