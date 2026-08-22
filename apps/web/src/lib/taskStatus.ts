// Maps a backend TaskStatus onto what the run UI shows: coarse run status,
// status/result labels, and which primary/secondary actions are offered.

import type {
  TaskStatus
} from "@zenbar/shared";

export const statusTone: Record<TaskStatus, string> = {
  queued: "slate",
  starting: "blue",
  running: "blue",
  waiting_user_input: "orange",
  waiting_result_approval: "orange",
  stopped: "slate",
  failed: "red",
  completed: "green"
};

export type RunStatus = "running" | "waiting_approval" | "completed" | "failed";

export type RunActionIntent = "primary" | "danger";

export type RunExecutionAction = "run_again" | "retry";

export type RunActionConfig = {
  key: "stop" | "approve" | RunExecutionAction;
  label: string;
  intent: RunActionIntent;
};

export type SecondaryRunAction = { key: "reject" | "ask_changes"; label: string };

export function inferRunStatus(status: TaskStatus): RunStatus {
  if (status === "waiting_result_approval") {
    return "waiting_approval";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "stopped") {
    return "failed";
  }
  return "running";
}

export function getPrimaryAction(status: RunStatus): RunActionConfig {
  switch (status) {
    case "running":
      return { key: "stop", label: "Stop", intent: "danger" };
    case "waiting_approval":
      return { key: "approve", label: "Approve", intent: "primary" };
    case "completed":
      return { key: "run_again", label: "Run again", intent: "primary" };
    case "failed":
      return { key: "retry", label: "Retry", intent: "primary" };
  }
}

export function getSecondaryActions(status: RunStatus): SecondaryRunAction[] {
  if (status === "waiting_approval") {
    return [{ key: "reject", label: "Reject" }];
  }
  if (status === "completed") {
    return [{ key: "ask_changes", label: "Ask for changes" }];
  }
  return [];
}

export function getRunStatusLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting_approval":
      return "Waiting for approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

export function getRunResultLabel(status: RunStatus): string {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failure";
    case "waiting_approval":
      return "pending approval";
    case "running":
      return "in progress";
  }
}
