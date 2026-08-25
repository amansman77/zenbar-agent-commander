// The conversation transcript: the message list, the diff tab that replaces
// it, and the task-state affordances that sit inline with the messages
// (approve/stop while a task runs, retry after it fails).

import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  ConversationDetail,
  ConversationMessageItem,
  TaskDiff,
  PrInfo
} from "@zenbar/shared";
import { AssistantMessageGroup, ChatBubble } from "./ChatMessages";
import { GroupedDiff, PrDiffSection } from "./DiffView";

/** One user message, or a run of assistant messages ending in the final one. */
export type MessageGroup =
  | { kind: "user"; message: ConversationMessageItem }
  | { kind: "assistant"; intermediates: ConversationMessageItem[]; final: ConversationMessageItem };

type TaskActionMutation = { mutate: () => void; isPending: boolean };

export type ConversationTranscriptProps = {
  conversationId: string;
  conversation: ConversationDetail | undefined;
  isLoading: boolean;
  messageGroups: MessageGroup[];
  messagesEndRef: RefObject<HTMLDivElement | null>;

  // "chat" shows the messages; "diff" shows the task's changes instead.
  activeTab: "chat" | "diff";
  diffData: TaskDiff | undefined;
  diffExpanded: Record<string, boolean>;
  setDiffExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
  prInfos: PrInfo[] | undefined;

  isTaskActive: boolean;
  isWaitingApproval: boolean;
  isTaskFailed: boolean;
  isTaskStopped: boolean;
  failureReason: string | null;
  approveTaskMutation: TaskActionMutation;
  stopTaskMutation: TaskActionMutation;
  retryTaskMutation: TaskActionMutation;
};

export function ConversationTranscript({
  conversationId,
  conversation,
  isLoading,
  messageGroups,
  messagesEndRef,
  activeTab,
  diffData,
  diffExpanded,
  setDiffExpanded,
  prInfos,
  isTaskActive,
  isWaitingApproval,
  isTaskFailed,
  isTaskStopped,
  failureReason,
  approveTaskMutation,
  stopTaskMutation,
  retryTaskMutation,
}: ConversationTranscriptProps) {
  return (
  <div style={{ flex: 1, overflowY: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
    {isLoading && <p className="empty-state">Loading...</p>}
    {!isLoading && conversation?.messages.length === 0 && activeTab === "chat" && (
      <p className="empty-state" style={{ textAlign: "center", marginTop: "2rem" }}>
        Start typing below to begin the conversation.
      </p>
    )}
    {activeTab === "diff" &&
      prInfos?.map((prInfo) => (
        <div className="pr-info-card" key={prInfo.url}>
          <a href={prInfo.url} target="_blank" rel="noreferrer" className="pr-info-card-link">
            <div className="pr-info-card-header">
              <span
                className={`status ${
                  prInfo.state === "merged" ? "status-blue" : prInfo.state === "open" ? "status-green" : "status-red"
                }`}
              >
                {prInfo.platform === "github" ? "GitHub" : "GitLab"} #{prInfo.number} · {prInfo.state}
              </span>
            </div>
            <strong className="pr-info-card-title">{prInfo.title}</strong>
            {prInfo.source_branch && prInfo.target_branch ? (
              <span className="item-secondary mono">
                {prInfo.source_branch} → {prInfo.target_branch}
              </span>
            ) : null}
            {prInfo.description ? <p className="pr-info-card-description">{prInfo.description}</p> : null}
          </a>
          <PrDiffSection conversationId={conversationId} url={prInfo.url} diff={prInfo.diff} />
        </div>
      ))}
    {activeTab === "diff" && (prInfos?.length ?? 0) === 0 && (
      // No PR/MR mentioned yet -- fall back to the task's own workspace
      // diff (uncommitted changes). Once a PR/MR shows up, each card
      // above carries its own diff instead, so this flat block steps
      // aside rather than showing a redundant "latest PR/MR only" copy.
      diffData?.raw_diff ? (
        <GroupedDiff
          rawDiff={diffData.raw_diff}
          filesChanged={diffData.files_changed ?? []}
          expanded={diffExpanded}
          onToggle={(id) => setDiffExpanded((prev) => ({ ...prev, [id]: !prev[id] }))}
        />
      ) : (
        <p className="empty-state">변경된 파일이 없습니다.</p>
      )
    )}
    {activeTab === "chat" && messageGroups.map((group) =>
      group.kind === "user" ? (
        <div key={group.message.id} style={{ display: "flex", justifyContent: "flex-end" }}>
          <ChatBubble message={group.message} taskId={conversation?.task_id ?? null} />
        </div>
      ) : (
        <AssistantMessageGroup
          key={group.final.id}
          intermediates={group.intermediates}
          final={group.final}
          taskId={conversation?.task_id ?? null}
        />
      )
    )}
    {activeTab === "chat" && isTaskActive && (
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div
          style={{
            padding: "0.55rem 0.75rem",
            borderRadius: "14px 14px 14px 4px",
            background: "#f0f4fa",
            color: "#16253a",
            fontSize: "0.88rem",
          }}
        >
          {isWaitingApproval ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span>Codex가 변경 사항 승인을 요청하고 있습니다.</span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={() => approveTaskMutation.mutate()}
                  disabled={approveTaskMutation.isPending || stopTaskMutation.isPending}
                  style={{ fontSize: "0.85rem" }}
                >
                  {approveTaskMutation.isPending ? "승인 중..." : "승인"}
                </button>
                <button
                  onClick={() => stopTaskMutation.mutate()}
                  disabled={approveTaskMutation.isPending || stopTaskMutation.isPending}
                  style={{ fontSize: "0.85rem", background: "#e53935", color: "#fff" }}
                >
                  {stopTaskMutation.isPending ? "거절 중..." : "거절"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span style={{ opacity: 0.7 }}>Codex is thinking...</span>
              <button
                onClick={() => stopTaskMutation.mutate()}
                disabled={stopTaskMutation.isPending}
                style={{ fontSize: "0.78rem", padding: "4px 12px", background: "#e53935", color: "#fff", flexShrink: 0 }}
              >
                {stopTaskMutation.isPending ? "중지 중..." : "중지"}
              </button>
            </div>
          )}
        </div>
      </div>
    )}
    {activeTab === "chat" && (isTaskFailed || isTaskStopped) && (
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div
          style={{
            padding: "0.55rem 0.75rem",
            borderRadius: "14px 14px 14px 4px",
            background: isTaskFailed ? "#fdecea" : "#f0f4fa",
            color: isTaskFailed ? "#7a1f1f" : "#16253a",
            fontSize: "0.88rem",
            maxWidth: "85%",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span>
              {isTaskFailed ? "⚠️ 작업이 실패했습니다." : "⏹ 작업이 중지되었습니다."}
              {failureReason ? ` ${failureReason}` : ""}
            </span>
            {isTaskFailed && (
              <button
                onClick={() => retryTaskMutation.mutate()}
                disabled={retryTaskMutation.isPending}
                style={{ fontSize: "0.8rem", alignSelf: "flex-start" }}
              >
                {retryTaskMutation.isPending ? "재시도 중..." : "다시 시도"}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    <div ref={messagesEndRef} />
  </div>
  );
}
