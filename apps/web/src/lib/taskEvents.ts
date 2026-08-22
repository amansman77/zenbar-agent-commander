// Everything derived from a task's raw TaskEvent stream: classifying events
// into conversation/execution/system, collapsing noise, building the timeline
// the detail screen renders, and extracting the latest plan and failure reason.

import type {
  TaskEvent
} from "@zenbar/shared";

export type PlanStep = { step: string; status: string };

export type PlanSnapshot = { explanation: string | null; steps: PlanStep[]; text: string | null };

export type LogType = "conversation" | "execution" | "system";

export type SystemImportance = "high" | "low";

export type ExecutionSummary = {
  commands: number;
  fileChanges: number;
  diffs: number;
};

export type TimelineItem =
  | { id: string; kind: "conversation"; event: TaskEvent }
  | { id: string; kind: "execution"; events: TaskEvent[] }
  | { id: string; kind: "system"; event: TaskEvent }
  | { id: string; kind: "technical"; events: TaskEvent[] };

function inferEventRole(event: TaskEvent): string | null {
  const payload = event.payload_json;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const role = payload.role;
  if (typeof role === "string") {
    return role.toLowerCase();
  }
  return null;
}

export function getEventText(event: TaskEvent): string {
  const payload = event.payload_json;
  if (payload && typeof payload === "object" && typeof payload.content === "string") {
    const content = payload.content.trim();
    if (content.length > 0) {
      return content;
    }
  }
  return (event.message || "").trim();
}

function isExecutionEvent(event: TaskEvent): boolean {
  return event.type === "command_executed" || event.type === "diff_generated" || event.type === "file_changed";
}

function isNarrativeEvent(event: TaskEvent): boolean {
  const role = inferEventRole(event);
  const text = getEventText(event);
  if (role === "assistant" || role === "user") {
    return true;
  }
  return typeof text === "string" && text.length > 20;
}

function classifyLogEvent(event: TaskEvent): LogType {
  if (isExecutionEvent(event)) {
    return "execution";
  }
  if (isNarrativeEvent(event)) {
    return "conversation";
  }
  return "system";
}

function getSystemImportance(event: TaskEvent): SystemImportance {
  if (
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "stopped" ||
    event.type === "result_approval_requested" ||
    event.type === "user_input_requested"
  ) {
    return "high";
  }
  return "low";
}

function dedupeLowSystemEvents(events: TaskEvent[]): TaskEvent[] {
  return events.filter((event, index, list) => {
    if (event.type !== "agent_status") {
      return true;
    }
    const previous = list[index - 1];
    if (!previous) {
      return true;
    }
    return !(previous.type === "agent_status" && previous.message === event.message);
  });
}

export function buildExecutionSummary(events: TaskEvent[]): ExecutionSummary {
  return {
    commands: events.filter((event) => event.type === "command_executed").length,
    fileChanges: events.filter((event) => event.type === "file_changed").length,
    diffs: events.filter((event) => event.type === "diff_generated").length
  };
}

export function formatExecutionEventLabel(event: TaskEvent): string {
  if (event.type === "file_changed") {
    return `updated ${event.message}`;
  }
  if (event.type === "command_executed") {
    return `ran ${event.message}`;
  }
  if (event.type === "diff_generated") {
    return event.message || "generated diff";
  }
  return event.message;
}

export function buildTimelineItems(events: TaskEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let executionBuffer: TaskEvent[] = [];
  let technicalBuffer: TaskEvent[] = [];

  const flushExecution = () => {
    if (executionBuffer.length === 0) {
      return;
    }
    const first = executionBuffer[0];
    const last = executionBuffer[executionBuffer.length - 1];
    items.push({ id: `execution-${first.id}-${last.id}`, kind: "execution", events: executionBuffer });
    executionBuffer = [];
  };

  const flushTechnical = () => {
    if (technicalBuffer.length === 0) {
      return;
    }
    const deduped = dedupeLowSystemEvents(technicalBuffer);
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (first && last) {
      items.push({ id: `technical-${first.id}-${last.id}`, kind: "technical", events: deduped });
    }
    technicalBuffer = [];
  };

  for (const event of events) {
    const type = classifyLogEvent(event);
    if (type === "execution") {
      flushTechnical();
      executionBuffer.push(event);
      continue;
    }
    if (type === "conversation") {
      flushExecution();
      flushTechnical();
      items.push({ id: event.id, kind: "conversation", event });
      continue;
    }
    flushExecution();
    if (getSystemImportance(event) === "high") {
      flushTechnical();
      items.push({ id: event.id, kind: "system", event });
    } else {
      technicalBuffer.push(event);
    }
  }

  flushExecution();
  flushTechnical();
  return items;
}

export function formatSystemEventLabel(event: TaskEvent): string {
  if (event.type === "completed") {
    return "Completed ✓";
  }
  if (event.type === "failed") {
    return "Failed";
  }
  if (event.type === "stopped") {
    return "Stopped";
  }
  if (event.type === "result_approval_requested") {
    return "Waiting approval";
  }
  if (event.type === "user_input_requested") {
    return "Waiting input";
  }
  return event.message || event.type.replace(/_/g, " ");
}

export function getConversationSpeaker(event: TaskEvent): string {
  const role = inferEventRole(event);
  if (role === "user") {
    return "User";
  }
  if (role === "assistant") {
    return "Agent";
  }
  return "Agent";
}

export function extractLatestPlan(events: TaskEvent[]): PlanSnapshot | null {
  const deltaChunks: string[] = [];
  let latestExplanation: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "plan_updated") {
      const payload = event.payload_json;
      const explanation =
        payload && typeof payload.explanation === "string" ? payload.explanation : latestExplanation;
      const rawPlan = payload && Array.isArray(payload.plan) ? payload.plan : [];
      const steps = rawPlan
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          step: typeof item.step === "string" ? item.step : "Unnamed step",
          status: typeof item.status === "string" ? item.status : "pending"
        }));
      if (steps.length > 0 || explanation || deltaChunks.length > 0) {
        return {
          explanation,
          steps,
          text: deltaChunks.length > 0 ? deltaChunks.reverse().join("") : null
        };
      }
    }
    if (event.type === "plan_delta") {
      const payload = event.payload_json;
      if (payload && typeof payload.delta === "string") {
        deltaChunks.push(payload.delta);
      }
      continue;
    }
    if (event.type === "agent_status" && !latestExplanation && event.message.toLowerCase().includes("plan")) {
      latestExplanation = event.message;
    }
  }
  if (deltaChunks.length === 0) {
    return null;
  }
  return { explanation: latestExplanation, steps: [], text: deltaChunks.reverse().join("") };
}

export function extractFailureReason(events: TaskEvent[] | undefined): string | null {
  if (!events?.length) {
    return null;
  }
  const failedEvents = events.filter((event) => event.type === "failed");
  if (failedEvents.length === 0) {
    return null;
  }
  const last = failedEvents[failedEvents.length - 1];
  try {
    const parsed = JSON.parse(last.message);
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // message isn't JSON, fall through to the raw text
  }
  return last.message;
}
