// Subscribes to a task's SSE event stream and keeps its react-query caches
// (events, detail, diff, conversations) current while the task is open.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  TaskDetail,
  TaskDiff,
  TaskEvent
} from "@zenbar/shared";
import { TECHNICAL_EVENT_TYPES, api } from "../api";

export function useTaskStream(taskId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!taskId) {
      return;
    }

    const source = new EventSource(api.streamUrl(taskId));
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { event: TaskEvent; task: TaskDetail; diff: TaskDiff };
      const isTechnical = (TECHNICAL_EVENT_TYPES as string[]).includes(payload.event.type);
      queryClient.setQueryData(["task", taskId], payload.task);
      queryClient.setQueryData(
        ["task-events", taskId, "lean"],
        (previous: { events: TaskEvent[]; hiddenTechnicalCount: number; latestEventAt: string | null } | undefined) => {
          const base = previous ?? { events: [], hiddenTechnicalCount: 0, latestEventAt: null };
          const alreadyPresent = base.events.some((item) => item.id === payload.event.id);
          return {
            events: !isTechnical && !alreadyPresent ? [...base.events, payload.event] : base.events,
            hiddenTechnicalCount: isTechnical ? base.hiddenTechnicalCount + 1 : base.hiddenTechnicalCount,
            latestEventAt: payload.event.created_at
          };
        }
      );
      // The full (unfiltered) cache is only ever created by the user
      // explicitly tapping "load full timeline" -- don't spontaneously
      // create it here, that would silently skip the REST fetch that's
      // supposed to backfill everything older than this one live event.
      queryClient.setQueryData(["task-events", taskId, "full"], (previous: TaskEvent[] | undefined) => {
        if (!previous) {
          return previous;
        }
        if (previous.some((item) => item.id === payload.event.id)) {
          return previous;
        }
        return [...previous, payload.event];
      });
      queryClient.setQueryData(["task-diff", taskId], payload.diff);
      queryClient.invalidateQueries({ queryKey: ["tasks", payload.task.project_id] });
    };
    source.onerror = () => {
      // Keep EventSource's built-in auto-reconnect behavior.
    };

    return () => source.close();
  }, [queryClient, taskId]);
}
