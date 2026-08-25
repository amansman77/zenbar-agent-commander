// Conversation message bubbles and assistant message grouping.

import { useState } from "react";
import type {
  ConversationMessageItem
} from "@zenbar/shared";
import { api } from "../api";
import { extractImageSegments, isRemoteImageUrl } from "../lib/messageImages";

// A screenshot/evidence image an agent mentioned by path, rendered as an
// actual thumbnail instead of the raw path text. taskId is only available
// once a task exists, and a remote URL doesn't need it at all -- both are
// the "fall back to plain text" cases, since there's nothing to fetch a
// local workspace path from without a task to scope it to.
function MessageImage({ path, taskId }: { path: string; taskId: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = isRemoteImageUrl(path) ? path : taskId ? api.workspaceFileUrl(taskId, path) : null;

  if (!src || failed) {
    return <code className="inline-code">{path}</code>;
  }

  return (
    <a href={src} target="_blank" rel="noreferrer" style={{ display: "block", margin: "4px 0" }}>
      <img
        src={src}
        alt={path}
        onError={() => setFailed(true)}
        style={{ display: "block", maxWidth: "100%", maxHeight: "260px", borderRadius: "8px", border: "1px solid var(--line)" }}
      />
    </a>
  );
}

function MessageContent({ content, taskId }: { content: string; taskId: string | null }) {
  const segments = extractImageSegments(content);
  if (segments.length === 1 && segments[0].type === "text") {
    return <>{content}</>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "image" ? (
          <MessageImage key={`img-${index}`} path={segment.path} taskId={taskId} />
        ) : (
          <span key={`text-${index}`}>{segment.value}</span>
        )
      )}
    </>
  );
}

export function ChatBubble({ message, taskId = null, muted = false }: { message: ConversationMessageItem; taskId?: string | null; muted?: boolean }) {
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
      <MessageContent content={message.content} taskId={taskId} />
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
  taskId = null,
}: {
  intermediates: ConversationMessageItem[];
  final: ConversationMessageItem;
  taskId?: string | null;
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
          {expanded && intermediates.map((message) => <ChatBubble key={message.id} message={message} taskId={taskId} muted />)}
        </div>
      )}
      <ChatBubble message={final} taskId={taskId} />
    </div>
  );
}
