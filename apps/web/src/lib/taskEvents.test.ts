import type { TaskEvent } from "@zenbar/shared";
import { buildTimelineItems, formatSystemEventLabel } from "./taskEvents";

function event(partial: Partial<TaskEvent> & Pick<TaskEvent, "type">): TaskEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    task_id: "task-1",
    seq: partial.seq ?? 1,
    message: partial.message ?? "",
    payload_json: partial.payload_json ?? null,
    created_at: partial.created_at ?? "2026-09-20T13:46:34Z",
    type: partial.type,
  };
}

describe("session_restarted in the timeline", () => {
  // A restart is the moment the agent loses the conversation and the task's
  // original prompt is re-sent. Folding it into the collapsed technical group
  // is what made that look like the agent simply forgetting, so it has to
  // stand on its own.
  it("renders as its own item rather than being collapsed with technical noise", () => {
    const items = buildTimelineItems([
      event({ type: "agent_status", seq: 1, message: "Turn started" }),
      event({ type: "session_restarted", seq: 2, message: "이전 세션이 만료되어..." }),
      event({ type: "agent_status", seq: 3, message: "Turn started" }),
    ]);
    expect(items.filter((item) => item.kind === "system")).toHaveLength(1);
    const systemItem = items.find((item) => item.kind === "system");
    expect(systemItem && "event" in systemItem && systemItem.event.type).toBe("session_restarted");
  });

  it("has a label that names the consequence, not just the event", () => {
    const label = formatSystemEventLabel(event({ type: "session_restarted" }));
    expect(label).toContain("새 세션");
    expect(label).toContain("끊김");
  });
});
