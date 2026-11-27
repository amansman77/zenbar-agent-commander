import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledActionListItem } from "@zenbar/shared";
import { api } from "../api";
import { formatFullTimestamp } from "../lib/format";

const queryKey = ["scheduled-actions"] as const;
const statuses = {
  pending: { label: "실행 대기", tone: "slate" },
  running: { label: "진행 중", tone: "blue" },
  completed: { label: "완료", tone: "green" },
  failed: { label: "실패", tone: "red" },
  stopped: { label: "중지", tone: "slate" },
};

export function ScheduledActionsScreen({ onOpenConversation, onBack }: {
  onOpenConversation: (id: string) => void;
  onBack?: () => void;
}) {
  const queryClient = useQueryClient();
  const actions = useQuery({ queryKey, queryFn: api.listScheduledActions, refetchInterval: 15_000 });
  const cancel = useMutation({
    mutationFn: (action: ScheduledActionListItem) => api.cancelScheduledAction(action.conversation_id, action.id),
    onSettled: (_data, _error, action) => Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: ["conversation", action.conversation_id] }),
    ]),
  });

  return (
    <section className="panel mobile-screen" aria-labelledby="scheduled-actions-title">
      <div className="panel-header mobile-title-row">
        {onBack && <button type="button" className="secondary mobile-back" onClick={onBack}>뒤로</button>}
        <h2 id="scheduled-actions-title">예약 작업</h2>
      </div>
      {actions.isPending && <p className="empty-state" role="status">예약 작업을 불러오는 중입니다.</p>}
      {actions.isError && (
        <div>
          <p role="alert">예약 작업을 불러오지 못했습니다.</p>
          <button type="button" className="secondary" onClick={() => void actions.refetch()}>다시 시도</button>
        </div>
      )}
      {actions.isSuccess && actions.data.length === 0 && <p className="empty-state">예약된 작업이 없습니다.</p>}
      {cancel.isError && <p role="alert">예약을 취소하지 못했습니다. 작업 상태를 확인해 주세요.</p>}
      {actions.data && actions.data.length > 0 && (
        <ul className="panel-scroll scheduled-actions-list">
          {actions.data.map((action) => {
            const status = statuses[action.status];
            return (
              <li key={action.id} className="scheduled-action-row">
                <div className="scheduled-action-meta">
                  <time dateTime={action.run_at}>{formatFullTimestamp(action.run_at)}</time>
                  <span className={`status status-${status.tone}`}>{status.label}</span>
                </div>
                <p className="scheduled-action-content">{action.content}</p>
                <div className="scheduled-action-meta">
                  <button type="button" className="secondary" onClick={() => onOpenConversation(action.conversation_id)}>
                    {action.project_name ? `${action.project_name} / ` : ""}{action.conversation_title}
                  </button>
                  {action.status === "pending" && (
                    <button type="button" className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(action)}>
                      예약 취소
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
