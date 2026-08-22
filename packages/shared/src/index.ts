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

export interface RuntimeEngineOption {
  id: string;
  label: string;
}

export interface ListRuntimeEnginesResponse {
  engines: RuntimeEngineOption[];
  default_engine: string;
}

export interface RuntimeProfileOption {
  id: string;
  description: string | null;
  model: string | null;
}

export interface ListRuntimeProfilesResponse {
  profiles: RuntimeProfileOption[];
}

export interface RuntimeSkill {
  id: string;
  name: string;
  description: string | null;
}

export interface ListRuntimeSkillsResponse {
  skills: RuntimeSkill[];
  source: "runtime" | "fallback";
}

export interface RuntimeUsageWindow {
  percent_used: number;
  resets_label: string | null;
  // ISO 8601, only set when the engine's source gives a real timestamp
  // (Codex, Antigravity) -- lets the UI show a "N일 M시간 후" countdown.
  // Unset for Claude (free-text reset prose, not reliably parseable).
  resets_at: string | null;
}

export interface RuntimeUsageInfo {
  session: RuntimeUsageWindow | null;
  week: RuntimeUsageWindow | null;
}

export interface RuntimeUsageResponse {
  engine: string;
  usage: RuntimeUsageInfo | null;
}

export interface PrInfo {
  platform: "github" | "gitlab";
  number: number;
  title: string;
  description: string | null;
  state: string;
  url: string;
  source_branch: string | null;
  target_branch: string | null;
  author: string | null;
  merged_at: string | null;
  // This PR/MR's own changed-file list, so the diff tab can show each
  // card's files grouped under that card instead of one flat list with no
  // indication of which PR/MR they came from.
  diff: TaskDiff | null;
}

export interface TaskSummary {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  execution_mode: ExecutionMode;
  engine: string | null;
  model: string | null;
  effective_model: string | null;
  profile: string | null;
  reasoning_effort: ReasoningEffort | null;
  workspace_type: WorkspaceType;
  workspace_ref: string;
  workspace_path: string | null;
  runtime_session_id: string | null;
  pipeline_id?: string | null;
  pipeline_name?: string | null;
  pipeline_step_index?: number | null;
  pipeline_total_steps?: number | null;
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

export interface SessionTurn {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface SessionRun {
  id: string;
  session_id: string;
  parent_run_id: string | null;
  status: "running" | "completed" | "failed";
  input: string;
  created_at: string;
}

export interface TaskDetail extends TaskSummary {
  prompt: string;
  session_id: string;
  turns: SessionTurn[];
  runs: SessionRun[];
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

export interface ProjectPrompt {
  id: string;
  project_id: string;
  title: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectPromptRequest {
  title: string;
  content: string;
}

export interface UpdateProjectPromptRequest {
  title?: string;
  content?: string;
}

export interface ProjectPipeline {
  id: string;
  project_id: string;
  name: string;
  prompt_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateProjectPipelineRequest {
  name: string;
  prompt_ids: string[];
}

export interface UpdateProjectPipelineRequest {
  name?: string;
  prompt_ids?: string[];
}

export interface CreateTaskRequest {
  project_id: string;
  title: string;
  prompt: string;
  engine?: string | null;
  model: string;
  profile?: string | null;
  reasoning_effort?: ReasoningEffort;
  execution_mode?: ExecutionMode;
  workspace_type?: WorkspaceType;
}

export interface ApproveTaskRequest {
  actor?: string;
  model?: string;
  profile?: string;
}

export interface RespondTaskRequest {
  actor?: string;
  answers: Record<string, string[]>;
}

export interface FollowupTurnRequest {
  content: string;
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

export interface ConversationMessageItem {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  last_message: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_status: TaskStatus | null;
  updated_at: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_status: TaskStatus | null;
  task_workspace_ref: string | null;
  task_base_branch: string | null;
  task_model: string | null;
  task_profile: string | null;
  task_engine: string | null;
  task_pipeline_id?: string | null;
  task_pipeline_name?: string | null;
  task_pipeline_step_index?: number | null;
  task_pipeline_total_steps?: number | null;
  messages: ConversationMessageItem[];
  created_at: string;
  updated_at: string;
}

export interface CreateConversationRequest {
  title?: string;
  project_id?: string;
}

export interface AddConversationMessageRequest {
  content: string;
  role?: string;
  selected_skill?: string | null;
  engine?: string | null;
  model?: string | null;
  profile?: string | null;
  pipeline_id?: string | null;
}

export interface FsBrowseEntry {
  name: string;
  path: string;
}

export interface FsBrowseResponse {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

export interface TaskGitActionResult {
  ok: boolean;
  branch: string | null;
  remote: string | null;
  message: string;
  output: string | null;
}
