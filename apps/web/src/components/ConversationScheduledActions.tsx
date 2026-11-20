import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationDetail, CreateScheduledActionRequest } from "@zenbar/shared";
import { api } from "../api";

const statusLabels = {
  pending: "실행 예정",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
  stopped: "중지",
};

export function ConversationScheduledActions({
  conversation,
  draft,
  onScheduled,
}: {
  conversation: ConversationDetail;
  draft: string;
  onScheduled: (content: string) => void;
}) {
  const queryClient = useQueryClient();
  const contentId = useId();
  const timeId = useId();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [runAt, setRunAt] = useState("");
  const [timeError, setTimeError] = useState("");
  const conversationKey = ["conversation", conversation.id] as const;

  const schedule = useMutation({
    mutationFn: (payload: CreateScheduledActionRequest) => api.createScheduledAction(conversation.id, payload),
    onSuccess: (updated, payload) => {
      queryClient.setQueryData(conversationKey, updated);
      setContent("");
      setRunAt("");
      setOpen(false);
      onScheduled(payload.content);
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelScheduledAction(conversation.id, id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: conversationKey }),
  });

  const actions = conversation.scheduled_actions ?? [];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="compose-scheduled-actions">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open && !content) setContent(draft.trim());
          setOpen(!open);
        }}
      >
        작업 예약
      </button>
      {actions.length > 0 && (
        <details>
          <summary>예약 작업 ({actions.length})</summary>
          <ul>
            {actions.map((action) => (
              <li key={action.id}>
                <strong>
                  {new Date(action.run_at).toLocaleString()} · {
                    action.status === "pending" && Date.parse(action.run_at) <= Date.now()
                      ? "실행 대기"
                      : statusLabels[action.status]
                  }
                </strong>
                <div>{action.content}</div>
                {action.status === "pending" && (
                  <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(action.id)}>
                    예약 취소
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {cancel.isError && <p role="alert">예약 취소에 실패했습니다. 작업 상태를 확인해 주세요.</p>}
      {open && (
        <form onSubmit={(event) => {
          event.preventDefault();
          const date = new Date(runAt);
          if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
            setTimeError("현재보다 이후의 시각을 선택해 주세요.");
            return;
          }
          setTimeError("");
          schedule.mutate({ content: content.trim(), run_at: date.toISOString() });
        }}>
          <label htmlFor={contentId}>실행할 작업</label>
          <textarea id={contentId} value={content} onChange={(event) => setContent(event.target.value)} required />
          <label htmlFor={timeId}>실행 시각 ({timeZone})</label>
          <input
            id={timeId}
            type="datetime-local"
            value={runAt}
            onChange={(event) => {
              setRunAt(event.target.value);
              setTimeError("");
            }}
            required
          />
          {timeError && <p role="alert">{timeError}</p>}
          {schedule.isError && <p role="alert">예약을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
          <button type="submit" disabled={!content.trim() || !runAt || schedule.isPending}>
            예약 확정
          </button>
        </form>
      )}
    </div>
  );
}
