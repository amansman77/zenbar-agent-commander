// Human-facing time formatting: relative timestamps and rate-limit reset lines.

import type {
  RuntimeUsageWindow
} from "@zenbar/shared";

export function formatRelativeTime(timestamp: string): string {
  const target = new Date(timestamp).getTime();
  const now = Date.now();
  const deltaMs = Math.max(0, now - target);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Only set for engines whose usage source gives a real timestamp (Codex,
// Antigravity) -- Claude's /usage is free-text prose ("resets Thursday
// 8am", no year) that isn't reliably parseable, so resets_at is left unset
// there and this is simply never called for it.
export function formatRemainingTime(resetsAtIso: string): string | null {
  const resetsAt = new Date(resetsAtIso).getTime();
  if (Number.isNaN(resetsAt)) {
    return null;
  }
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) {
    return "곧 초기화";
  }
  const totalMinutes = Math.round(diffMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}일 ${hours}시간 후`;
  }
  if (hours > 0) {
    return `${hours}시간 ${minutes}분 후`;
  }
  return `${minutes}분 후`;
}

export function formatUsageResetLine(label: string, window: RuntimeUsageWindow): string {
  const absolute = window.resets_label ?? "정보 없음";
  const remaining = window.resets_at ? formatRemainingTime(window.resets_at) : null;
  return remaining ? `${label} 리셋: ${absolute} (${remaining})` : `${label} 리셋: ${absolute}`;
}
