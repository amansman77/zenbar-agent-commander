// Conversation message bubbles and assistant message grouping.

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ConversationMessageItem
} from "@zenbar/shared";
import { api } from "../api";
import { copyToClipboard } from "../lib/clipboard";
import { formatFullTimestamp, formatMessageTime } from "../lib/format";
import { classifyReferencePath, extractMessageSegments, isRemoteImageUrl } from "../lib/messageImages";

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

// A self-contained HTML prototype an agent produced, rendered inline.
//
// sandbox WITHOUT allow-same-origin is the whole security model here: these
// prototypes only work with their scripts running (they build their own DOM),
// but the HTML is agent-authored, so it must not execute on the dashboard's
// origin, where it could read localStorage or call the API with the user's
// token. allow-scripts alone gives it an opaque origin -- scripts run, the
// dashboard stays unreachable. The endpoint sends a matching
// `Content-Security-Policy: sandbox allow-scripts` so the same holds if the
// preview is opened in its own tab, where this attribute would not apply.
function MessageHtml({ path, taskId }: { path: string; taskId: string | null }) {
  if (!taskId) {
    return <code className="inline-code">{path}</code>;
  }
  const src = api.workspaceFileUrl(taskId, path);
  const name = path.split("/").pop() || path;
  return (
    <span style={{ display: "block", margin: "6px 0" }}>
      <iframe
        src={src}
        title={name}
        sandbox="allow-scripts"
        style={{
          display: "block",
          width: "100%",
          height: "420px",
          border: "1px solid var(--line)",
          borderRadius: "8px",
          background: "var(--surface, #fff)"
        }}
      />
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        style={{ display: "inline-block", marginTop: "4px", fontSize: "0.8rem" }}
      >
        {name} 새 탭에서 열기
      </a>
    </span>
  );
}

function renderSegments(content: string, taskId: string | null): ReactNode {
  const segments = extractMessageSegments(content);
  if (segments.length === 1 && segments[0].type === "text") {
    return content;
  }
  return segments.map((segment, index) =>
    segment.type === "image" ? (
      <MessageImage key={`img-${index}`} path={segment.path} taskId={taskId} />
    ) : segment.type === "html" ? (
      <MessageHtml key={`html-${index}`} path={segment.path} taskId={taskId} />
    ) : (
      <span key={`text-${index}`}>{segment.value}</span>
    )
  );
}

function MessageContent({ content, taskId }: { content: string; taskId: string | null }) {
  return <>{renderSegments(content, taskId)}</>;
}

function MessageReference({ target, taskId, fallback }: { target: string; taskId: string | null; fallback: ReactNode }) {
  const reference = classifyReferencePath(target);
  if (reference?.type === "image") return <MessageImage path={reference.path} taskId={taskId} />;
  if (reference?.type === "html") return <MessageHtml path={reference.path} taskId={taskId} />;
  return <>{fallback}</>;
}

// Codex writes the files it produced as `sandbox:/tmp/shot.png`.
// react-markdown's default transform blanks any URL whose scheme it does not
// know, so the prefix is stripped first, the same way extractMessageSegments
// strips it. Every other URL still goes through the default transform, which
// is what blocks `javascript:` links in agent-written markdown.
function transformMessageUrl(url: string): string {
  return defaultUrlTransform(url.replace(/^sandbox:/i, ""));
}

// Assistant replies are markdown, and are rendered as markdown. The file
// references extractMessageSegments finds in plain text (images, HTML
// prototypes) still have to become thumbnails and previews. Markdown links,
// images and inline code arrive here as parsed nodes, and a quoted or bare
// path in prose arrives as a text child of the block around it, so references
// are resolved per node instead of by splitting the raw message. Splitting it
// first would break a list or a table in two around every screenshot.
function MarkdownMessage({ content, taskId }: { content: string; taskId: string | null }) {
  const withReferences = (children: ReactNode) =>
    Children.map(children, (child) => (typeof child === "string" ? renderSegments(child, taskId) : child));

  const components: Components = {
    p: ({ children }) => <p>{withReferences(children)}</p>,
    li: ({ children, className }) => <li className={className}>{withReferences(children)}</li>,
    td: ({ children, style }) => <td style={style}>{withReferences(children)}</td>,
    img: ({ src, alt }) =>
      typeof src === "string" && src ? (
        <MessageReference target={src} taskId={taskId} fallback={<code className="inline-code">{alt || src}</code>} />
      ) : null,
    a: ({ href, children }) => {
      const link = (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
      return href ? <MessageReference target={href} taskId={taskId} fallback={link} /> : link;
    },
    pre: ({ children }) => <pre className="output-pre">{children}</pre>,
    code: ({ children, className }) => {
      const text = String(children ?? "");
      // Fenced blocks carry a language class or span lines; anything else is
      // inline code, where a backticked screenshot path is the common way an
      // agent mentions one.
      if (className || text.includes("\n")) {
        return <code className={className}>{children}</code>;
      }
      const segments = extractMessageSegments(text);
      if (segments.length === 1 && segments[0].type === "image") {
        return <MessageImage path={segments[0].path} taskId={taskId} />;
      }
      return <code className="inline-code">{children}</code>;
    },
  };

  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={transformMessageUrl} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Copies a message's original text: what the user typed, or the agent's
// markdown source rather than the rendered page, which is what pastes cleanly
// into another chat, an issue or an editor.
function MessageCopyButton({ content }: { content: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    const copied = await copyToClipboard(content);
    setState(copied ? "copied" : "error");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setState("idle"), 1500);
  };

  const label = state === "copied" ? "복사됨" : state === "error" ? "복사 실패" : "메시지 복사";
  return (
    <button
      type="button"
      className={`icon-button message-copy-button${state === "idle" ? "" : ` ${state}`}`}
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {state === "copied" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

export function ChatBubble({ message, taskId = null, muted = false }: { message: ConversationMessageItem; taskId?: string | null; muted?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-message${isUser ? " chat-message-user" : ""}`}>
      <div
        style={{
          maxWidth: "100%",
          padding: "0.55rem 0.75rem",
          borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          background: isUser ? "#0f3158" : muted ? "#f7f8fa" : "#f0f4fa",
          color: isUser ? "#fff" : muted ? "#5b6472" : "#16253a",
          fontSize: muted ? "0.85rem" : "0.93rem",
          fontStyle: muted ? "italic" : "normal",
          lineHeight: "1.45",
          // A user's own message is shown as typed. Markdown spaces its own
          // blocks, so pre-wrap there would double every paragraph gap.
          whiteSpace: isUser ? "pre-wrap" : "normal",
          wordBreak: "break-word",
        }}
      >
        {isUser ? (
          <MessageContent content={message.content} taskId={taskId} />
        ) : (
          <MarkdownMessage content={message.content} taskId={taskId} />
        )}
      </div>
      <div className="chat-message-meta">
        <time className="chat-message-time" dateTime={message.created_at} title={formatFullTimestamp(message.created_at)}>
          {formatMessageTime(message.created_at)}
        </time>
        <MessageCopyButton content={message.content} />
      </div>
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
