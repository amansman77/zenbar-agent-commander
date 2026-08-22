// Conversation message bubbles and assistant message grouping.

import { useState } from "react";
import type {
  ConversationMessageItem
} from "@zenbar/shared";

export function ChatBubble({ message, muted = false }: { message: ConversationMessageItem; muted?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        maxWidth: "85%",
        padding: "0.55rem 0.75rem",
        borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
        background: isUser ? "#0f3158" : muted ? "#f7f8fa" : "#f0f4fa",
        color: isUser ? "#fff" : muted ? "#5b6472" : "#16253a",
        fontSize: muted ? "0.85rem" : "0.93rem",
        fontStyle: muted ? "italic" : "normal",
        lineHeight: "1.45",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {message.content}
    </div>
  );
}

// Groups a run of consecutive assistant messages: `final` is always shown as
// a normal chat bubble; `intermediates` (Codex's status updates/notes along
// the way to that final answer) start collapsed behind a small toggle,
// mirroring the Codex app's own collapsible "thinking" section.
export function AssistantMessageGroup({
  intermediates,
  final,
}: {
  intermediates: ConversationMessageItem[];
  final: ConversationMessageItem;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
      {intermediates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start", width: "100%" }}>
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            style={{
              background: "none",
              border: "none",
              padding: "2px 4px",
              color: "var(--text-soft)",
              fontSize: "0.78rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span>{expanded ? "▾" : "▸"}</span>
            <span>중간 응답 {intermediates.length}개 {expanded ? "접기" : "보기"}</span>
          </button>
          {expanded && intermediates.map((message) => <ChatBubble key={message.id} message={message} muted />)}
        </div>
      )}
      <ChatBubble message={final} />
    </div>
  );
}
