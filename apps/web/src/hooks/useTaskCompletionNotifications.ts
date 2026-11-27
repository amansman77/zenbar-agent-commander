// Watches task status changes and persisted scheduled-action updates.

import { useEffect, useRef } from "react";
import type { ConversationSummary, TaskStatus } from "@zenbar/shared";
import { TASK_STATUS_NOTIFICATION_LABEL, isNotificationSupported, isNotifyWorthyTransition } from "../lib/notifications";

const scheduledNotificationsStartKey = "zenbar:scheduledNotificationsStart";
const scheduledNotificationKey = (conversationId: string) => `zenbar:scheduledNotification:${conversationId}`;

export function useTaskCompletionNotifications(conversations: ConversationSummary[] | undefined, enabled: boolean) {
  const previousStatusesRef = useRef<Map<string, TaskStatus | null> | null>(null);

  useEffect(() => {
    if (!conversations) return;
    const previous = previousStatusesRef.current;
    previousStatusesRef.current = new Map(conversations.map((conv) => [conv.id, conv.task_status]));

    if (!enabled || !isNotificationSupported() || Notification.permission !== "granted") {
      window.localStorage.removeItem(scheduledNotificationsStartKey);
      return;
    }
    const storedStart = window.localStorage.getItem(scheduledNotificationsStartKey);
    const start = storedStart ? Number(storedStart) : Date.now();
    if (!storedStart) window.localStorage.setItem(scheduledNotificationsStartKey, String(start));

    for (const conv of conversations) {
      const scheduledAt = conv.last_scheduled_update_at ? Date.parse(conv.last_scheduled_update_at) : 0;
      const seenKey = scheduledNotificationKey(conv.id);
      const seen = Number(window.localStorage.getItem(seenKey));
      const scheduledUpdate = scheduledAt > Math.max(start, seen);
      const currentStatus = conv.task_status;
      const finished = previous !== null && isNotifyWorthyTransition(previous.get(conv.id) ?? null, currentStatus);
      if (!scheduledUpdate && !finished) continue;

      const label = scheduledUpdate
        ? scheduledUpdateLabel(currentStatus)
        : currentStatus && TASK_STATUS_NOTIFICATION_LABEL[currentStatus];
      const notification = new Notification(`[${label}] ${conv.title}`, {
        body: conv.last_message ?? undefined,
        tag: `zenbar-task-${conv.id}`,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      if (scheduledUpdate) window.localStorage.setItem(seenKey, String(scheduledAt));
    }
  }, [conversations, enabled]);
}

function scheduledUpdateLabel(status: TaskStatus | null): string {
  if (status === "waiting_user_input") return "예약 작업 답변 필요";
  if (status === "waiting_result_approval") return "예약 작업 승인 필요";
  return "예약 작업 결과";
}
