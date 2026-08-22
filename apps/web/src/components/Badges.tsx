// Inline status pill for a task, and the account rate-limit/usage badge.

import { useState, type CSSProperties } from "react";
import type {
  RuntimeUsageInfo,
  TaskStatus
} from "@zenbar/shared";
import { formatUsageResetLine } from "../lib/format";
import { statusTone } from "../lib/taskStatus";

// The percent-used badge used to put its reset time in a `title` tooltip --
// invisible on mobile, since there's no hover there. Reported live: "주간
// 사용량만 나오고 언제 만료인지 몰라서 불편하다" while on mobile. Now a tap
// toggles a second line showing it instead, which works on both touch and
// mouse (the tooltip is dropped, not kept as a redundant desktop-only path).
// That line also leads with a "남은 시간" countdown when a real timestamp
// is available, per a same-day follow-up request -- an absolute reset time
// alone still makes the reader do the subtraction themselves.
export function UsageBadge({ usage, style }: { usage: RuntimeUsageInfo; style?: CSSProperties }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const resetLines = [
    usage.session ? formatUsageResetLine("세션", usage.session) : null,
    usage.week ? formatUsageResetLine("주간", usage.week) : null,
  ].filter((line): line is string => Boolean(line));

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: "2px", ...style }}>
      <button
        type="button"
        onClick={() => setDetailsOpen((prev) => !prev)}
        disabled={resetLines.length === 0}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "inherit",
          cursor: resetLines.length > 0 ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        ⏱{usage.session ? ` 세션 ${usage.session.percent_used}%` : ""}
        {usage.week ? ` · 주간 ${usage.week.percent_used}%` : ""}
        {resetLines.length > 0 ? (detailsOpen ? " ▲" : " ▾") : ""}
      </button>
      {detailsOpen ? <span style={{ fontSize: "0.68rem", opacity: 0.85 }}>{resetLines.join(" · ")}</span> : null}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const label =
    status === "waiting_result_approval"
      ? "Waiting for approval"
      : status === "waiting_user_input"
        ? "Waiting for input"
        : status === "starting"
          ? "Starting"
          : status === "queued"
            ? "Queued"
            : status === "stopped"
              ? "Stopped"
              : status === "running"
                ? "Running"
                : status === "completed"
                  ? "Completed"
                  : "Failed";
  return <span className={`status status-${statusTone[status]}`}>{label}</span>;
}
