// Watches conversation task statuses and fires a browser notification when one
// finishes or starts waiting on the user.

import { useEffect, useRef } from "react";
import type {
  ConversationSummary,
  TaskStatus
} from "@zenbar/shared";
import { TASK_STATUS_NOTIFICATION_LABEL, isNotificationSupported, isNotifyWorthyTransition } from "../lib/notifications";

export function useTaskCompletionNotifications(conversations: ConversationSummary[] | undefined, enabled: boolean) {
  const previousStatusesRef = useRef<Map<string, TaskStatus | null> | null>(null);

  useEffect(() => {
    if (!conversations) return;
    const previous = previousStatusesRef.current;
    const next = new Map(conversations.map((conv) => [conv.id, conv.task_status] as const));

    if (previous === null) {
      previousStatusesRef.current = next;
      return;
    }

    if (enabled && isNotificationSupported() && Notification.permission === "granted") {
      for (const conv of conversations) {
        const prevStatus = previous.get(conv.id) ?? null;
        const currentStatus = conv.task_status;
        if (isNotifyWorthyTransition(prevStatus, currentStatus)) {
          const label = (currentStatus && TASK_STATUS_NOTIFICATION_LABEL[currentStatus]) ?? currentStatus;
          const notification = new Notification(`[${label}] ${conv.title}`, {
            body: conv.last_message ?? undefined,
            tag: `zenbar-task-${conv.id}`,
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }
      }
    }

    previousStatusesRef.current = next;
  }, [conversations, enabled]);
}
