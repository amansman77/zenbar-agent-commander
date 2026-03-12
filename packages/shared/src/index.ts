export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "approved"
  | "stopped"
  | "failed"
  | "completed";

export type WorkspaceType = "branch" | "worktree";

export type EventType =
  | "agent_status"
  | "file_changed"
  | "command_executed"
  | "diff_generated"
  | "waiting_approval"
  | "test_result"
  | "completed"
  | "failed"
  | "stopped";

export interface ProjectSummary {
  id: string;
  name: string;
  repo_path: string;
  default_branch: string;
  created_at: string;
}

export interface TaskSummary {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
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

export interface TaskDetail extends TaskSummary {
  prompt: string;
  project: ProjectSummary;
  approvals: TaskApproval[];
  latest_diff: TaskDiff;
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
  workspace_type?: WorkspaceType;
}

export interface ApproveTaskRequest {
  actor?: string;
}
