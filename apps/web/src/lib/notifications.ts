// Browser notification support for task completion: permission/enabled state and
// which status transitions are worth notifying about.

import type {
  TaskStatus
} from "@zenbar/shared";

export const ACTIVE_TASK_STATUSES: TaskStatus[] = ["queued", "starting", "running", "waiting_user_input", "waiting_result_approval"];

export const TASK_NOTIFICATIONS_ENABLED_KEY = "zenbar:taskNotificationsEnabled";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function loadTaskNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(TASK_NOTIFICATIONS_ENABLED_KEY) === "true";
}

// The stored "enabled" flag only ever gets set to true right after the
// browser actually granted permission (see App.tsx's toggle handler), but
// nothing re-checks it later -- so if the user (or the browser) revokes
// notification permission afterwards, the flag stays stale and the bell
// keeps showing 🔔 even though no notification will ever actually fire.
// Reported live: the icon showed "on" while the browser's own permission
// was blocked, with no visible reason why until the bell was clicked.
export function isNotificationPermissionGranted(): boolean {
  return isNotificationSupported() && Notification.permission === "granted";
}

export const TASK_STATUS_NOTIFICATION_LABEL: Partial<Record<TaskStatus, string>> = {
  completed: "완료",
  failed: "실패",
  stopped: "중지",
};

// Watches every conversation's task_status (not just whichever one is open)
// for a transition from an active status into a terminal one, and fires a
// browser Notification for it -- scoped globally per the user's explicit
// choice ("모든 진행 중인 작업 전체"), not just the currently-viewed
// conversation. The first snapshot after mount/reload only *records*
// statuses rather than firing: without that, every already-terminal task
// present on initial load would notify at once.
// Pure decision logic, split out from the effect below so it's testable
// without touching React/timers/the Notification API: a transition is
// notify-worthy exactly when the previous status was active, the current
// one is terminal, and the two actually differ (guards against a status
// staying e.g. "completed" -> "completed" across a poll from re-firing).
export function isNotifyWorthyTransition(previousStatus: TaskStatus | null, currentStatus: TaskStatus | null): boolean {
  const wasActive = previousStatus != null && ACTIVE_TASK_STATUSES.includes(previousStatus);
  const isNowTerminal = currentStatus != null && !ACTIVE_TASK_STATUSES.includes(currentStatus);
  return wasActive && isNowTerminal && previousStatus !== currentStatus;
}
