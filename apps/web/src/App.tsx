import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AddConversationMessageRequest,
  ConversationDetail,
  ConversationSummary,
  CreateProjectRequest,
  CreateTaskRequest,
  DiscoverProjectResponse,
  ExecutionMode,
  FsBrowseResponse,
  ProjectPrompt,
  ReasoningEffort,
  RuntimeModelOption,
  RuntimeProfileOption,
  RuntimeSkill,
  ProjectSummary,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskQuestion,
  TaskStatus
} from "@zenbar/shared";
import { api } from "./api";

const actor = "web-commander";
const LAST_TASK_MODEL_KEY = "zenbar:lastTaskModel";

const statusTone: Record<TaskStatus, string> = {
  queued: "slate",
  starting: "blue",
  running: "blue",
  waiting_user_input: "orange",
  waiting_result_approval: "orange",
  stopped: "slate",
  failed: "red",
  completed: "green"
};

function defaultAnswers(questions: TaskQuestion[]): Record<string, string> {
  return Object.fromEntries(questions.map((question) => [question.id, ""]));
}

type PlanStep = { step: string; status: string };
type PlanSnapshot = { explanation: string | null; steps: PlanStep[]; text: string | null };
type MobileScreen = "conversations" | "conversation-detail" | "projects" | "project-prompts" | "tasks" | "detail";
type RunStatus = "running" | "waiting_approval" | "completed" | "failed";
type LogType = "conversation" | "execution" | "system";
type SystemImportance = "high" | "low";
type RunActionIntent = "primary" | "danger";
type RunExecutionAction = "run_again" | "retry";
type RunActionConfig = {
  key: "stop" | "approve" | RunExecutionAction;
  label: string;
  intent: RunActionIntent;
};
type SecondaryRunAction = { key: "reject" | "ask_changes"; label: string };

type ParsedDiffFile = {
  id: string;
  fileName: string;
  lines: string[];
  additions: number;
  deletions: number;
};

type ExecutionSummary = {
  commands: number;
  fileChanges: number;
  diffs: number;
};

type TimelineItem =
  | { id: string; kind: "conversation"; event: TaskEvent }
  | { id: string; kind: "execution"; events: TaskEvent[] }
  | { id: string; kind: "system"; event: TaskEvent }
  | { id: string; kind: "technical"; events: TaskEvent[] };

function inferEventRole(event: TaskEvent): string | null {
  const payload = event.payload_json;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const role = payload.role;
  if (typeof role === "string") {
    return role.toLowerCase();
  }
  return null;
}

function getEventText(event: TaskEvent): string {
  const payload = event.payload_json;
  if (payload && typeof payload === "object" && typeof payload.content === "string") {
    const content = payload.content.trim();
    if (content.length > 0) {
      return content;
    }
  }
  return (event.message || "").trim();
}

function isExecutionEvent(event: TaskEvent): boolean {
  return event.type === "command_executed" || event.type === "diff_generated" || event.type === "file_changed";
}

function isNarrativeEvent(event: TaskEvent): boolean {
  const role = inferEventRole(event);
  const text = getEventText(event);
  if (role === "assistant" || role === "user") {
    return true;
  }
  return typeof text === "string" && text.length > 20;
}

function classifyLogEvent(event: TaskEvent): LogType {
  if (isExecutionEvent(event)) {
    return "execution";
  }
  if (isNarrativeEvent(event)) {
    return "conversation";
  }
  return "system";
}

function getSystemImportance(event: TaskEvent): SystemImportance {
  if (
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "stopped" ||
    event.type === "result_approval_requested" ||
    event.type === "user_input_requested"
  ) {
    return "high";
  }
  return "low";
}

function dedupeLowSystemEvents(events: TaskEvent[]): TaskEvent[] {
  return events.filter((event, index, list) => {
    if (event.type !== "agent_status") {
      return true;
    }
    const previous = list[index - 1];
    if (!previous) {
      return true;
    }
    return !(previous.type === "agent_status" && previous.message === event.message);
  });
}

function buildExecutionSummary(events: TaskEvent[]): ExecutionSummary {
  return {
    commands: events.filter((event) => event.type === "command_executed").length,
    fileChanges: events.filter((event) => event.type === "file_changed").length,
    diffs: events.filter((event) => event.type === "diff_generated").length
  };
}

function formatExecutionEventLabel(event: TaskEvent): string {
  if (event.type === "file_changed") {
    return `updated ${event.message}`;
  }
  if (event.type === "command_executed") {
    return `ran ${event.message}`;
  }
  if (event.type === "diff_generated") {
    return event.message || "generated diff";
  }
  return event.message;
}

function buildTimelineItems(events: TaskEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let executionBuffer: TaskEvent[] = [];
  let technicalBuffer: TaskEvent[] = [];

  const flushExecution = () => {
    if (executionBuffer.length === 0) {
      return;
    }
    const first = executionBuffer[0];
    const last = executionBuffer[executionBuffer.length - 1];
    items.push({ id: `execution-${first.id}-${last.id}`, kind: "execution", events: executionBuffer });
    executionBuffer = [];
  };

  const flushTechnical = () => {
    if (technicalBuffer.length === 0) {
      return;
    }
    const deduped = dedupeLowSystemEvents(technicalBuffer);
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (first && last) {
      items.push({ id: `technical-${first.id}-${last.id}`, kind: "technical", events: deduped });
    }
    technicalBuffer = [];
  };

  for (const event of events) {
    const type = classifyLogEvent(event);
    if (type === "execution") {
      flushTechnical();
      executionBuffer.push(event);
      continue;
    }
    if (type === "conversation") {
      flushExecution();
      flushTechnical();
      items.push({ id: event.id, kind: "conversation", event });
      continue;
    }
    flushExecution();
    if (getSystemImportance(event) === "high") {
      flushTechnical();
      items.push({ id: event.id, kind: "system", event });
    } else {
      technicalBuffer.push(event);
    }
  }

  flushExecution();
  flushTechnical();
  return items;
}

function formatSystemEventLabel(event: TaskEvent): string {
  if (event.type === "completed") {
    return "Completed ✓";
  }
  if (event.type === "failed") {
    return "Failed";
  }
  if (event.type === "stopped") {
    return "Stopped";
  }
  if (event.type === "result_approval_requested") {
    return "Waiting approval";
  }
  if (event.type === "user_input_requested") {
    return "Waiting input";
  }
  return event.message || event.type.replace(/_/g, " ");
}

function getConversationSpeaker(event: TaskEvent): string {
  const role = inferEventRole(event);
  if (role === "user") {
    return "User";
  }
  if (role === "assistant") {
    return "Agent";
  }
  return "Agent";
}

function extractLatestPlan(events: TaskEvent[]): PlanSnapshot | null {
  const deltaChunks: string[] = [];
  let latestExplanation: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "plan_updated") {
      const payload = event.payload_json;
      const explanation =
        payload && typeof payload.explanation === "string" ? payload.explanation : latestExplanation;
      const rawPlan = payload && Array.isArray(payload.plan) ? payload.plan : [];
      const steps = rawPlan
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          step: typeof item.step === "string" ? item.step : "Unnamed step",
          status: typeof item.status === "string" ? item.status : "pending"
        }));
      if (steps.length > 0 || explanation || deltaChunks.length > 0) {
        return {
          explanation,
          steps,
          text: deltaChunks.length > 0 ? deltaChunks.reverse().join("") : null
        };
      }
    }
    if (event.type === "plan_delta") {
      const payload = event.payload_json;
      if (payload && typeof payload.delta === "string") {
        deltaChunks.push(payload.delta);
      }
      continue;
    }
    if (event.type === "agent_status" && !latestExplanation && event.message.toLowerCase().includes("plan")) {
      latestExplanation = event.message;
    }
  }
  if (deltaChunks.length === 0) {
    return null;
  }
  return { explanation: latestExplanation, steps: [], text: deltaChunks.reverse().join("") };
}

function useTaskStream(taskId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!taskId) {
      return;
    }

    const source = new EventSource(api.streamUrl(taskId));
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { event: TaskEvent; task: TaskDetail; diff: TaskDiff };
      queryClient.setQueryData(["task", taskId], payload.task);
      queryClient.setQueryData(["task-events", taskId], (previous: TaskEvent[] | undefined) => {
        if (!previous) {
          return [payload.event];
        }
        if (previous.some((item) => item.id === payload.event.id)) {
          return previous;
        }
        return [...previous, payload.event];
      });
      queryClient.setQueryData(["task-diff", taskId], payload.diff);
      queryClient.invalidateQueries({ queryKey: ["tasks", payload.task.project_id] });
    };
    source.onerror = () => {
      // Keep EventSource's built-in auto-reconnect behavior.
    };

    return () => source.close();
  }, [queryClient, taskId]);
}

function useIsMobileBreakpoint() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return isMobile;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={`bold-${index}`}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={`code-${index}`} className="inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    return <span key={`text-${index}`}>{token}</span>;
  });
}

function MarkdownRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let listBuffer: string[] = [];
  let orderedList = false;

  const flushList = () => {
    if (listBuffer.length === 0) {
      return;
    }
    const items = listBuffer.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>);
    blocks.push(orderedList ? <ol key={`ol-${key++}`}>{items}</ol> : <ul key={`ul-${key++}`}>{items}</ul>);
    listBuffer = [];
  };

  const flushCode = () => {
    if (!inCodeBlock) {
      return;
    }
    blocks.push(
      <pre key={`pre-${key++}`} className="output-pre">
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
    codeLines = [];
    inCodeBlock = false;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
      } else {
        flushList();
        inCodeBlock = true;
      }
      index += 1;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      index += 1;
      continue;
    }

    const listMatch = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /\d+\./.test(listMatch[1]);
      if (listBuffer.length > 0 && orderedList !== isOrdered) {
        flushList();
      }
      orderedList = isOrdered;
      listBuffer.push(listMatch[2]);
      index += 1;
      continue;
    }

    flushList();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const headingText = headingMatch[2];
      if (headingMatch[1].length === 1) {
        blocks.push(<h3 key={`h1-${key++}`}>{renderInlineMarkdown(headingText)}</h3>);
      } else if (headingMatch[1].length === 2) {
        blocks.push(<h4 key={`h2-${key++}`}>{renderInlineMarkdown(headingText)}</h4>);
      } else {
        blocks.push(<h5 key={`h3-${key++}`}>{renderInlineMarkdown(headingText)}</h5>);
      }
      index += 1;
      continue;
    }

    blocks.push(
      <p key={`p-${key++}`} className="markdown-paragraph">
        {renderInlineMarkdown(line)}
      </p>
    );
    index += 1;
  }

  flushList();
  flushCode();
  return <div className="markdown-view">{blocks}</div>;
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "diff-line-meta";
  }
  if (line.startsWith("@@")) {
    return "diff-line-hunk";
  }
  if (line.startsWith("+")) {
    return "diff-line-add";
  }
  if (line.startsWith("-")) {
    return "diff-line-remove";
  }
  return "diff-line-neutral";
}

function inferRunStatus(status: TaskStatus): RunStatus {
  if (status === "waiting_result_approval") {
    return "waiting_approval";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "stopped") {
    return "failed";
  }
  return "running";
}

function getPrimaryAction(status: RunStatus): RunActionConfig {
  switch (status) {
    case "running":
      return { key: "stop", label: "Stop", intent: "danger" };
    case "waiting_approval":
      return { key: "approve", label: "Approve", intent: "primary" };
    case "completed":
      return { key: "run_again", label: "Run again", intent: "primary" };
    case "failed":
      return { key: "retry", label: "Retry", intent: "primary" };
  }
}

function getSecondaryActions(status: RunStatus): SecondaryRunAction[] {
  if (status === "waiting_approval") {
    return [{ key: "reject", label: "Reject" }];
  }
  if (status === "completed") {
    return [{ key: "ask_changes", label: "Ask for changes" }];
  }
  return [];
}

function getRunStatusLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting_approval":
      return "Waiting for approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

function getRunResultLabel(status: RunStatus): string {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failure";
    case "waiting_approval":
      return "pending approval";
    case "running":
      return "in progress";
  }
}

function formatRelativeTime(timestamp: string): string {
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

function parseDiffFiles(rawDiff: string): ParsedDiffFile[] {
  const lines = rawDiff.split("\n");
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  const flushCurrent = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const fileName = match?.[2] ?? line.replace("diff --git ", "");
      current = {
        id: `${fileName}-${files.length}`,
        fileName,
        lines: [line],
        additions: 0,
        deletions: 0
      };
      continue;
    }
    if (!current) {
      current = {
        id: `raw-${files.length}`,
        fileName: `changes-${files.length + 1}`,
        lines: [],
        additions: 0,
        deletions: 0
      };
    }
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }

  flushCurrent();
  return files;
}

function ColoredDiff({ rawDiff }: { rawDiff: string }) {
  const lines = rawDiff.split("\n");
  return (
    <pre className="output-pre diff-pre">
      <code>
        {lines.map((line, index) => (
          <span key={`diff-${index}`} className={`diff-line ${diffLineClass(line)}`}>
            {line || " "}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
}

function GroupedDiff({
  rawDiff,
  filesChanged,
  expanded,
  onToggle
}: {
  rawDiff: string;
  filesChanged: string[];
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  const parsed = useMemo(() => parseDiffFiles(rawDiff), [rawDiff]);
  const groups = parsed.length > 0 ? parsed : filesChanged.map((file, index) => ({ id: `${file}-${index}`, fileName: file, lines: [], additions: 0, deletions: 0 }));

  return (
    <div className="diff-groups">
      {groups.map((group) => {
        const isExpanded = Boolean(expanded[group.id]);
        const changeCount = group.additions + group.deletions;
        return (
          <section key={group.id} className="diff-group">
            <button type="button" className="diff-group-header" onClick={() => onToggle(group.id)} aria-expanded={isExpanded}>
              <span className="mono truncate">{group.fileName}</span>
              <span className="diff-change-count">
                {changeCount} changes
              </span>
            </button>
            {isExpanded && group.lines.length > 0 ? <ColoredDiff rawDiff={group.lines.join("\n")} /> : null}
          </section>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
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

function ConversationItem({ event, mobile }: { event: TaskEvent; mobile: boolean }) {
  const text = getEventText(event) || "(No message)";
  const speaker = getConversationSpeaker(event);
  return (
    <article className="timeline-item timeline-conversation">
      <div className="row-header">
        <strong>{speaker}</strong>
      </div>
      <p className={mobile ? "event-message conversation-message mobile" : "event-message conversation-message"}>{text}</p>
      <p className="event-meta">
        <span>{new Date(event.created_at).toLocaleTimeString()}</span>
      </p>
    </article>
  );
}

function ExecutionBlock({ events, mobile }: { events: TaskEvent[]; mobile: boolean }) {
  const summary = useMemo(() => buildExecutionSummary(events), [events]);
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="timeline-item timeline-execution">
      <div className="row-header">
        <h3>Execution</h3>
        <button type="button" className="secondary" onClick={() => setExpanded((previous) => !previous)} disabled={events.length === 0}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      <div className="execution-summary">
        <p>- ran {summary.commands} commands</p>
        <p>- updated {summary.fileChanges} files</p>
        <p>- generated {summary.diffs} diffs</p>
      </div>

      {expanded ? (
        <ul className={mobile ? "mobile-event-list timeline-details-list" : "event-list timeline-details-list"}>
          {events.map((event) => (
            <li key={event.id}>
              <p className="event-message">{formatExecutionEventLabel(event)}</p>
              <p className="event-meta">
                <span>{new Date(event.created_at).toLocaleTimeString()}</span>
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function SystemEvent({ event }: { event: TaskEvent }) {
  return (
    <article className="timeline-item timeline-system-high">
      <div className="row-header">
        <h3>{formatSystemEventLabel(event)}</h3>
      </div>
      {event.message ? <p className="event-message event-message-agent-status">{event.message}</p> : null}
      <p className="event-meta">
        <span>{new Date(event.created_at).toLocaleTimeString()}</span>
      </p>
    </article>
  );
}

function TechnicalEventsBlock({ events, mobile }: { events: TaskEvent[]; mobile: boolean }) {
  return (
    <details className="timeline-item timeline-technical">
      <summary>View technical events ({events.length})</summary>
      <ul className={mobile ? "mobile-event-list timeline-details-list" : "event-list timeline-details-list"}>
        {events.map((event) => (
          <li key={event.id}>
            <p className="event-message event-message-agent-status">{event.message || event.type.replace(/_/g, " ")}</p>
            <p className="event-meta">
              <span>{new Date(event.created_at).toLocaleTimeString()}</span>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function StructuredLogTab({ events, mobile }: { events: TaskEvent[]; mobile: boolean }) {
  const items = useMemo(() => buildTimelineItems(events), [events]);

  return (
    <div className="log-timeline">
      {items.map((item) => {
        if (item.kind === "conversation") {
          return <ConversationItem key={item.id} event={item.event} mobile={mobile} />;
        }
        if (item.kind === "execution") {
          return <ExecutionBlock key={item.id} events={item.events} mobile={mobile} />;
        }
        if (item.kind === "system") {
          return <SystemEvent key={item.id} event={item.event} />;
        }
        return <TechnicalEventsBlock key={item.id} events={item.events} mobile={mobile} />;
      })}
    </div>
  );
}

function SessionComposer({
  value,
  disabled,
  pending,
  onChange,
  onSend
}: {
  value: string;
  disabled: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const canSend = value.trim().length > 0 && !disabled && !pending;
  return (
    <section className="session-composer">
      <textarea
        aria-label="Session follow-up"
        className="session-composer-input"
        placeholder="Ask the agent about this run..."
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || pending}
      />
      <div className="session-composer-actions">
        <button type="button" onClick={onSend} disabled={!canSend}>
          {pending ? "Sending..." : "Send"}
        </button>
      </div>
    </section>
  );
}

function ConversationListScreen({
  conversations,
  projects,
  isLoading,
  onSelect,
  onCreate,
  onDelete,
  onManageProjects,
}: {
  conversations: ConversationSummary[];
  projects: ProjectSummary[];
  isLoading: boolean;
  onSelect: (id: string) => void;
  onCreate: (projectId: string) => void;
  onDelete: (id: string) => void;
  onManageProjects: () => void;
}) {
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);

  return (
    <section className="panel mobile-screen">
      <div className="panel-header">
        <div className="row-header">
          <h2>Conversations</h2>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className="secondary" onClick={onManageProjects} style={{ fontSize: "0.8rem", padding: "4px 10px" }}>Projects</button>
            <button type="button" onClick={() => setProjectSheetOpen(true)}>+</button>
          </div>
        </div>
      </div>
      <div className="panel-scroll">
        {isLoading && <p className="empty-state">Loading...</p>}
        {!isLoading && conversations.length === 0 && (
          <p className="empty-state">No conversations yet. Tap + to start.</p>
        )}
        {conversations.map((conv) => (
          <div key={conv.id} style={{ display: "flex", alignItems: "stretch", gap: "4px" }}>
            <button className="list-item" style={{ flex: 1, minWidth: 0 }} onClick={() => onSelect(conv.id)}>
              <div className="list-row">
                <strong className="truncate">{conv.title}</strong>
                {conv.project_name && (
                  <span className="status status-slate" style={{ fontSize: "0.7rem" }}>{conv.project_name}</span>
                )}
              </div>
              {conv.last_message && (
                <span className="item-secondary truncate">{conv.last_message}</span>
              )}
              <span className="item-secondary" style={{ fontSize: "0.75rem" }}>
                {new Date(conv.updated_at).toLocaleString()}
              </span>
            </button>
            <button
              className="secondary"
              style={{ padding: "0 10px", fontSize: "0.8rem", flexShrink: 0, alignSelf: "center" }}
              onClick={() => onDelete(conv.id)}
              title="대화 삭제"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {projectSheetOpen && (
        <div className="bottom-sheet-backdrop" onClick={() => setProjectSheetOpen(false)}>
          <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="bottom-sheet-header">
              <h3>프로젝트 선택</h3>
              <button className="secondary" onClick={() => setProjectSheetOpen(false)}>✕</button>
            </div>
            <div className="bottom-sheet-list">
              {projects.length === 0 && (
                <p className="empty-state">No projects yet. Add a project first.</p>
              )}
              {projects.map((project) => (
                <button
                  key={project.id}
                  className="bottom-sheet-option"
                  onClick={() => {
                    setProjectSheetOpen(false);
                    onCreate(project.id);
                  }}
                >
                  <strong>{project.name}</strong>
                  <span style={{ display: "block", fontSize: "0.78rem", opacity: 0.7, marginTop: "2px" }}>
                    {project.repo_path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const ACTIVE_TASK_STATUSES: TaskStatus[] = ["queued", "starting", "running", "waiting_user_input", "waiting_result_approval"];

function ConversationDetailScreen({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobileBreakpoint();
  const [activeTab, setActiveTab] = useState<"chat" | "diff">("chat");
  const [diffExpanded, setDiffExpanded] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const promptMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const deleteConversationMutation = useMutation({
    mutationFn: () => api.deleteConversation(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onBack();
    },
  });

  const { data: conversation, isLoading } = useQuery<ConversationDetail>({
    queryKey: ["conversation", conversationId],
    queryFn: () => api.getConversation(conversationId),
    refetchInterval: (query) => {
      const data = query.state.data as ConversationDetail | undefined;
      const taskStatus = data?.task_status ?? null;
      return taskStatus && ACTIVE_TASK_STATUSES.includes(taskStatus) ? 1500 : 3000;
    },
  });

  const { data: skillsData } = useQuery({
    queryKey: ["runtime-skills"],
    queryFn: () => api.listRuntimeSkills(),
    staleTime: 5 * 60 * 1000,
  });
  const skills: RuntimeSkill[] = skillsData?.skills ?? [];

  const projectId = conversation?.project_id ?? null;
  const { data: promptsData } = useQuery({
    queryKey: ["project-prompts", projectId],
    queryFn: () => api.listProjectPrompts(projectId!),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
  const savedPrompts: ProjectPrompt[] = promptsData ?? [];

  const taskId = conversation?.task_id ?? null;
  const { data: diffData, refetch: refetchDiff } = useQuery({
    queryKey: ["conv-diff", taskId],
    queryFn: () => api.getDiff(taskId!),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });

  const { data: modelsData } = useQuery({
    queryKey: ["runtime-models"],
    queryFn: () => api.listRuntimeModels(),
    staleTime: 0,
  });
  const availableModels: string[] = (modelsData?.models ?? [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id !== "default");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const { data: profilesData } = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: () => api.listRuntimeProfiles(),
    staleTime: 5 * 60 * 1000,
  });
  const availableProfiles: RuntimeProfileOption[] = profilesData?.profiles ?? [];
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const selectedProfileOption = availableProfiles.find((p) => p.id === selectedProfile) ?? null;
  const profileControlsModel = Boolean(selectedProfileOption?.model);
  const effectiveModel = conversation?.task_model ?? selectedModel ?? availableModels[0] ?? null;
  const taskStarted = conversation?.task_id != null;

  const isTaskActive = conversation?.task_status != null && ACTIVE_TASK_STATUSES.includes(conversation.task_status);
  const isWaitingApproval = conversation?.task_status === "waiting_result_approval";

  const approveTaskMutation = useMutation({
    mutationFn: () => api.approveTask(conversation!.task_id!, { actor: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: Error) => {
      alert(`승인 실패: ${err.message}`);
    },
  });

  const stopTaskMutation = useMutation({
    mutationFn: () => api.stopTask(conversation!.task_id!, { actor: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
    onError: (err: Error) => {
      alert(`중지 실패: ${err.message}`);
    },
  });

  const addMessageMutation = useMutation({
    mutationFn: (payload: { content: string; selected_skill?: string | null; model?: string | null; profile?: string | null }) =>
      api.addConversationMessage(conversationId, payload),
    onSuccess: (updated) => {
      setInput("");
      setSelectedSkill(null);
      queryClient.setQueryData(["conversation", conversationId], updated);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err: Error) => {
      alert(`메시지 전송 실패: ${err.message}`);
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages.length]);

  useEffect(() => {
    if (activeTab === "chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [activeTab]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
        setSkillMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [skillMenuOpen]);

  useEffect(() => {
    if (!promptMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (promptMenuRef.current && !promptMenuRef.current.contains(e.target as Node)) {
        setPromptMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [promptMenuOpen]);

  const selectedSkillName = skills.find((s) => s.id === selectedSkill)?.name ?? null;
  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
    s.id.toLowerCase().includes(skillSearch.toLowerCase())
  );

  const isSendDisabled = !input.trim() || addMessageMutation.isPending || isTaskActive;

  const handleSend = () => {
    const trimmed = input.trim();
    if (trimmed && !isSendDisabled) {
      const modelToUse = taskStarted || profileControlsModel ? null : (selectedModel || availableModels[0] || null);
      const profileToUse = taskStarted ? null : selectedProfile;
      addMessageMutation.mutate({ content: trimmed, selected_skill: selectedSkill, model: modelToUse, profile: profileToUse });
    }
  };

  return (
    <section
      className="panel mobile-screen"
      style={{ display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}
    >
      <div className="mobile-detail-control">
        <div className="mobile-detail-control-top">
          <button type="button" className="secondary mobile-back" onClick={onBack}>Back</button>
          <div style={{ minWidth: 0 }}>
            <strong className="truncate" style={{ display: "block" }}>{conversation?.title ?? "Conversation"}</strong>
            {conversation?.project_name && (
              <span style={{ fontSize: "0.75rem", color: "var(--text-soft)" }}>{conversation.project_name}</span>
            )}
          </div>
          <button
            type="button"
            className="secondary"
            style={{ fontSize: "0.8rem", padding: "4px 10px", flexShrink: 0 }}
            disabled={deleteConversationMutation.isPending}
            onClick={() => deleteConversationMutation.mutate()}
            title="대화 삭제"
          >
            삭제
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {isLoading && <p className="empty-state">Loading...</p>}
        {!isLoading && conversation?.messages.length === 0 && activeTab === "chat" && (
          <p className="empty-state" style={{ textAlign: "center", marginTop: "2rem" }}>
            Start typing below to begin the conversation.
          </p>
        )}
        {activeTab === "diff" && (
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
        {activeTab === "chat" && conversation?.messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "85%",
                padding: "0.55rem 0.75rem",
                borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                background: msg.role === "user" ? "#0f3158" : "#f0f4fa",
                color: msg.role === "user" ? "#fff" : "#16253a",
                fontSize: "0.93rem",
                lineHeight: "1.45",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}
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
        <div ref={messagesEndRef} />
      </div>

      <div
        style={{
          borderTop: "1px solid var(--line)",
          background: "rgba(255,255,255,0.98)",
          paddingBottom: "calc(0px + env(safe-area-inset-bottom))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px 0", flexWrap: "wrap" }}>
          {conversation?.task_workspace_ref ? (
            <span
              title={`기본 브랜치: ${conversation.task_base_branch ?? "unknown"}`}
              style={{ fontSize: "0.73rem", color: "var(--text-soft)", whiteSpace: "nowrap" }}
            >
              ⎇ {conversation.task_workspace_ref}
              {conversation.task_base_branch && (
                <span style={{ opacity: 0.55 }}> ← {conversation.task_base_branch}</span>
              )}
            </span>
          ) : null}
          {taskStarted ? (
            effectiveModel ? (
              <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>◎ {effectiveModel}</span>
            ) : null
          ) : profileControlsModel ? (
            <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }} title="Model is set by the selected profile">
              ◎ {selectedProfileOption?.model}
            </span>
          ) : (
            availableModels.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.73rem", color: "var(--text-soft)" }}>
                <span>◎</span>
                <select
                  value={selectedModel ?? availableModels[0]}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  style={{
                    fontSize: "0.73rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-soft)",
                    cursor: "pointer",
                    padding: 0,
                    outline: "none",
                    maxWidth: "140px",
                  }}
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            )
          )}
          {taskStarted ? (
            conversation?.task_profile ? (
              <span style={{ fontSize: "0.73rem", color: "var(--text-soft)" }}>▤ {conversation.task_profile}</span>
            ) : null
          ) : (
            availableProfiles.length > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "0.73rem", color: "var(--text-soft)" }}>
                <span>▤</span>
                <select
                  value={selectedProfile ?? ""}
                  onChange={(e) => setSelectedProfile(e.target.value || null)}
                  title="Codex profile"
                  style={{
                    fontSize: "0.73rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-soft)",
                    cursor: "pointer",
                    padding: 0,
                    outline: "none",
                    maxWidth: "140px",
                  }}
                >
                  <option value="">No profile</option>
                  {availableProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.id}</option>
                  ))}
                </select>
              </label>
            )
          )}
          {taskId && (
            <button
              type="button"
              onClick={() => { setActiveTab((t) => t === "chat" ? "diff" : "chat"); if (activeTab === "chat") refetchDiff(); }}
              style={{
                marginLeft: skills.length > 0 ? "0" : "auto",
                padding: "4px 12px",
                borderRadius: "14px",
                fontSize: "0.78rem",
                fontWeight: activeTab === "diff" ? 600 : 400,
                border: activeTab === "diff" ? "1.5px solid #0f3158" : "1.5px solid var(--line)",
                background: activeTab === "diff" ? "#0f3158" : "transparent",
                color: activeTab === "diff" ? "#fff" : "var(--text-soft)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {activeTab === "diff" ? "💬 대화" : "📄 변경사항"}
            </button>
          )}
          {skills.length > 0 && (
            <div ref={skillMenuRef} style={{ position: "relative", marginLeft: taskId ? "0" : "auto" }}>
              <button
                type="button"
                onClick={() => { setSkillMenuOpen((o) => !o); setSkillSearch(""); }}
              style={{
                padding: "4px 12px",
                borderRadius: "14px",
                fontSize: "0.78rem",
                fontWeight: selectedSkill ? 600 : 400,
                border: selectedSkill ? "1.5px solid #0f3158" : "1.5px solid var(--line)",
                background: selectedSkill ? "#0f3158" : "transparent",
                color: selectedSkill ? "#fff" : "var(--text-soft)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {selectedSkillName ? `⚡ ${selectedSkillName}` : "⚡ Auto"}
            </button>
            {skillMenuOpen && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                zIndex: 200,
                background: "var(--panel)",
                border: "1px solid var(--line)",
                borderRadius: "10px",
                boxShadow: "var(--shadow)",
                width: "260px",
                overflow: "hidden",
              }}>
                <div style={{ padding: "8px" }}>
                  <input
                    autoFocus
                    type="text"
                    placeholder="스킬 검색..."
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 10px",
                      borderRadius: "8px",
                      border: "1px solid var(--line)",
                      fontSize: "0.82rem",
                      background: "var(--panel-soft)",
                      color: "var(--text)",
                      outline: "none",
                    }}
                  />
                </div>
                <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                  <button
                    type="button"
                    onClick={() => { setSelectedSkill(null); setSkillMenuOpen(false); }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 14px",
                      fontSize: "0.82rem",
                      background: !selectedSkill ? "var(--panel-soft)" : "transparent",
                      color: !selectedSkill ? "var(--primary)" : "var(--text)",
                      fontWeight: !selectedSkill ? 600 : 400,
                      border: "none",
                      borderRadius: 0,
                      cursor: "pointer",
                    }}
                  >
                    Auto
                  </button>
                  {filteredSkills.map((skill) => (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => { setSelectedSkill(skill.id); setSkillMenuOpen(false); }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: selectedSkill === skill.id ? "var(--panel-soft)" : "transparent",
                        color: selectedSkill === skill.id ? "var(--primary)" : "var(--text)",
                        fontWeight: selectedSkill === skill.id ? 600 : 400,
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {skill.name}
                    </button>
                  ))}
                  {filteredSkills.length === 0 && (
                    <p style={{ padding: "8px 14px", fontSize: "0.8rem", color: "var(--text-soft)", margin: 0 }}>
                      검색 결과 없음
                    </p>
                  )}
                </div>
              </div>
            )}
            </div>
          )}
          {savedPrompts.length > 0 && (
            <div ref={promptMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPromptMenuOpen((o) => !o)}
                title="저장된 프롬프트"
                style={{
                  padding: "4px 12px",
                  borderRadius: "14px",
                  fontSize: "0.78rem",
                  border: "1.5px solid var(--line)",
                  background: "transparent",
                  color: "var(--text-soft)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                📋 프롬프트
              </button>
              {promptMenuOpen && (
                <div style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 200,
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: "10px",
                  boxShadow: "var(--shadow)",
                  width: "260px",
                  maxHeight: "260px",
                  overflowY: "auto",
                }}>
                  {savedPrompts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setInput(item.content);
                        setPromptMenuOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 14px",
                        fontSize: "0.82rem",
                        background: "transparent",
                        color: "var(--text)",
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      <strong style={{ display: "block" }}>{item.title}</strong>
                      <span
                        className="item-secondary truncate"
                        style={{ display: "block", fontSize: "0.75rem" }}
                      >
                        {item.content}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", padding: "8px 12px" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isTaskActive ? "Codex is working..." : "메시지를 입력하세요..."}
            disabled={isTaskActive}
            style={{ flex: 1, minHeight: "44px", maxHeight: "120px", resize: "none", opacity: isTaskActive ? 0.5 : 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                e.preventDefault();
                handleSend();
              }
            }}
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={isSendDisabled}
            style={{ alignSelf: "flex-end", minHeight: "44px", padding: "0 16px" }}
          >
            {addMessageMutation.isPending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}

function ProjectPromptsScreen({
  project,
  onBack,
}: {
  project: ProjectSummary | null;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<ProjectPrompt | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const promptsQuery = useQuery({
    queryKey: ["project-prompts", project?.id ?? null],
    queryFn: () => api.listProjectPrompts(project!.id),
    enabled: Boolean(project),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["project-prompts", project?.id ?? null] });

  const createMutation = useMutation({
    mutationFn: (payload: { title: string; content: string }) => api.createProjectPrompt(project!.id, payload),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 저장 실패: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; title: string; content: string }) =>
      api.updateProjectPrompt(project!.id, payload.id, { title: payload.title, content: payload.content }),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: Error) => alert(`프롬프트 수정 실패: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (promptId: string) => api.deleteProjectPrompt(project!.id, promptId),
    onSuccess: () => invalidate(),
    onError: (err: Error) => alert(`프롬프트 삭제 실패: ${err.message}`),
  });

  const openCreateForm = () => {
    setEditingPrompt(null);
    setTitle("");
    setContent("");
    setFormOpen(true);
  };

  const openEditForm = (prompt: ProjectPrompt) => {
    setEditingPrompt(prompt);
    setTitle(prompt.title);
    setContent(prompt.content);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingPrompt(null);
    setTitle("");
    setContent("");
  };

  const canSubmit = Boolean(title.trim() && content.trim());
  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <section className="panel mobile-screen">
      <div className="panel-header">
        <div className="mobile-title-row">
          <button type="button" className="secondary mobile-back" onClick={onBack}>
            Back
          </button>
          <h2>{project ? `${project.name} 프롬프트` : "Prompts"}</h2>
        </div>
        <button type="button" onClick={openCreateForm} disabled={!project}>
          + Add prompt
        </button>
      </div>
      <div className="panel-scroll">
        {!project ? (
          <p className="empty-state">프로젝트를 먼저 선택하세요.</p>
        ) : promptsQuery.isLoading ? (
          <p className="empty-state">Loading...</p>
        ) : promptsQuery.data?.length ? (
          promptsQuery.data.map((prompt) => (
            <div key={prompt.id} className="list-item" style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{prompt.title}</strong>
                <p className="item-secondary" style={{ whiteSpace: "pre-wrap", marginTop: "4px" }}>
                  {prompt.content}
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
                <button type="button" className="secondary" style={{ fontSize: "0.75rem", padding: "4px 10px" }} onClick={() => openEditForm(prompt)}>
                  편집
                </button>
                <button
                  type="button"
                  className="secondary"
                  style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (confirm(`"${prompt.title}" 프롬프트를 삭제할까요?`)) {
                      deleteMutation.mutate(prompt.id);
                    }
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">저장된 프롬프트가 없습니다. "+ Add prompt"로 추가하세요.</p>
        )}
      </div>

      <Modal title={editingPrompt ? "Edit prompt" : "New prompt"} open={formOpen} onClose={closeForm}>
        <form
          className="panel form-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            if (editingPrompt) {
              updateMutation.mutate({ id: editingPrompt.id, title: title.trim(), content: content.trim() });
            } else {
              createMutation.mutate({ title: title.trim(), content: content.trim() });
            }
          }}
        >
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 버그 트리아지" />
          </label>
          <label>
            Prompt
            <textarea
              className="task-prompt-input"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="자주 쓰는 프롬프트 내용을 입력하세요."
            />
          </label>
          <button type="submit" disabled={!canSubmit || isSaving}>
            {isSaving ? "저장 중..." : "저장"}
          </button>
          <button type="button" className="secondary" onClick={closeForm}>
            취소
          </button>
        </form>
      </Modal>
    </section>
  );
}

function FolderBrowser({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobileBreakpoint();
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useQuery<FsBrowseResponse>({
    queryKey: ["fs-browse", currentPath],
    queryFn: () => api.browseFs(currentPath),
  });

  const cardClass = isMobile ? "modal-card modal-card-mobile-full" : "modal-card";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={cardClass} style={isMobile ? {} : { maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={isMobile ? { padding: "8px 16px" } : { marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "1rem" }}>폴더 선택</h2>
          <button className="modal-close-button secondary" onClick={onClose}>✕</button>
        </div>

        <div style={isMobile ? { padding: "12px 16px" } : {}}>
          {data && (
            <div style={{ marginBottom: "0.5rem", fontSize: "0.82rem", color: "var(--text-soft)", wordBreak: "break-all" }}>
              {data.path}
            </div>
          )}

          {isLoading && <p style={{ color: "var(--text-soft)", fontSize: "0.88rem" }}>로딩 중...</p>}
          {error && <p style={{ color: "#b12a34", fontSize: "0.88rem" }}>오류: {(error as Error).message}</p>}

          {data && (
            <div style={{ display: "grid", gap: "0.4rem", maxHeight: isMobile ? "calc(100vh - 240px)" : "340px", overflowY: "auto" }}>
              {data.parent !== null && (
                <button
                  className="list-item"
                  style={{ textAlign: "left" }}
                  onClick={() => setCurrentPath(data.parent!)}
                >
                  ↑ 상위 폴더
                </button>
              )}
              {data.entries.length === 0 && (
                <p className="empty-state">하위 폴더가 없습니다.</p>
              )}
              {data.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="list-item"
                  style={{ textAlign: "left" }}
                  onClick={() => setCurrentPath(entry.path)}
                >
                  📁 {entry.name}
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
            <button
              disabled={!data}
              onClick={() => data && onSelect(data.path)}
            >
              이 폴더 선택
            </button>
            <button className="secondary" onClick={onClose}>취소</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectForm({
  onCreate,
  onClose
}: {
  onCreate: (payload: CreateProjectRequest) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [lastDiscovered, setLastDiscovered] = useState<DiscoverProjectResponse | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);

  const discoverProjectMutation = useMutation({
    mutationFn: api.discoverProject,
    onSuccess: (project) => {
      setLastDiscovered(project);
      setDiscoveryError(null);
      setName(project.name);
      setRepoPath(project.repo_path);
      setDefaultBranch(project.default_branch);
    },
    onError: (error: Error) => {
      setDiscoveryError(error.message);
    }
  });

  const canSubmit = Boolean(name.trim() && repoPath.trim() && defaultBranch.trim());

  return (
    <>
      {folderBrowserOpen && (
        <FolderBrowser
          onSelect={(path) => {
            setFolderBrowserOpen(false);
            discoverProjectMutation.mutate({ path });
          }}
          onClose={() => setFolderBrowserOpen(false)}
        />
      )}
      <form
        className="panel form-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ name, repo_path: repoPath, default_branch: defaultBranch });
        }}
      >
        <div className="panel-header">
          <h2>Web Commander</h2>
          <p>Create a project record for the Orchestration API.</p>
        </div>
        <button
          type="button"
          onClick={() => setFolderBrowserOpen(true)}
          disabled={discoverProjectMutation.isPending}
        >
          {discoverProjectMutation.isPending ? "Checking folder..." : "Browse folder"}
        </button>
        {discoveryError ? <p role="alert">{discoveryError}</p> : null}
        {lastDiscovered ? <p>Selected: {lastDiscovered.repo_path}</p> : null}
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Repository path
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
          />
        </label>
        <label>
          Default branch
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!canSubmit}>
          Create project
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </form>
    </>
  );
}

function TaskForm({
  project,
  models,
  modelsLoading,
  modelsError,
  profiles,
  isMobile,
  onCreate,
  onClose
}: {
  project: ProjectSummary | null;
  models: RuntimeModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  profiles: RuntimeProfileOption[];
  isMobile: boolean;
  onCreate: (payload: CreateTaskRequest) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [model, setModel] = useState("");
  const [profile, setProfile] = useState("");
  const selectedProfileOption = profiles.find((p) => p.id === profile) ?? null;
  const profileControlsModel = Boolean(selectedProfileOption?.model);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [viewportInset, setViewportInset] = useState(0);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const available = models.map((item) => item.id);
    if (available.length === 0) {
      setModel("");
      return;
    }
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(LAST_TASK_MODEL_KEY) ?? "" : "";
    setModel((previous) => {
      if (previous && available.includes(previous)) {
        return previous;
      }
      if (saved && available.includes(saved)) {
        return saved;
      }
      return "";
    });
  }, [models]);

  useEffect(() => {
    if (!isMobile || step !== 1) {
      return;
    }
    titleRef.current?.focus();
  }, [isMobile, step]);

  useEffect(() => {
    if (!isMobile || typeof window === "undefined" || !window.visualViewport) {
      return;
    }
    const viewport = window.visualViewport;
    const syncInset = () => {
      const heightDelta = window.innerHeight - viewport.height - viewport.offsetTop;
      setViewportInset(Math.max(0, Math.round(heightDelta)));
    };
    syncInset();
    viewport.addEventListener("resize", syncInset);
    viewport.addEventListener("scroll", syncInset);
    return () => {
      viewport.removeEventListener("resize", syncInset);
      viewport.removeEventListener("scroll", syncInset);
    };
  }, [isMobile]);

  useEffect(() => {
    setPromptExpanded(false);
  }, [step]);

  const submitTask = () => {
    if (!project) {
      return;
    }
    if (typeof window !== "undefined" && model && !profileControlsModel) {
      window.localStorage.setItem(LAST_TASK_MODEL_KEY, model);
    }
    onCreate({
      project_id: project.id,
      title,
      prompt,
      model: profileControlsModel ? (selectedProfileOption!.model as string) : model,
      profile: profile || null,
      reasoning_effort: reasoningEffort,
      execution_mode: executionMode,
      workspace_type: "branch"
    });
  };

  const ensureFocusedInputVisible = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (typeof target.scrollIntoView !== "function") {
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const requiredFieldsFilled = title.trim().length > 0 && prompt.trim().length > 0;
  const canProceedStep1 = Boolean(project && requiredFieldsFilled);
  const modelReady = profileControlsModel || Boolean(model && models.length > 0 && !modelsLoading);
  const canProceedStep2 = Boolean(project && modelReady);
  const canSubmit = Boolean(project && modelReady);
  const promptPreview =
    prompt.length > 140
      ? `${prompt.slice(0, 140).replace(/\s+/g, " ").trimEnd()}...`
      : prompt.replace(/\s+/g, " ").trim();

  if (isMobile) {
    return (
      <form
        className="panel form-panel task-form-mobile"
        onSubmit={(event) => {
          event.preventDefault();
          if (step !== 3 || !canSubmit) {
            return;
          }
          submitTask();
        }}
      >
        <div className="mobile-task-flow">
          <div className="mobile-task-progress" aria-label={`Step ${step} of 3`}>
            <span className={step === 1 ? "active" : ""}>1. Basic Info</span>
            <span className={step === 2 ? "active" : ""}>2. Configuration</span>
            <span className={step === 3 ? "active" : ""}>3. Review</span>
          </div>

          {step === 1 ? (
            <section className="mobile-task-section">
              <label>
                Title
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onFocus={(event) => ensureFocusedInputVisible(event.target)}
                  enterKeyHint="next"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      promptRef.current?.focus();
                    }
                  }}
                  placeholder="Fix sitemap canonical"
                  disabled={!project}
                />
              </label>
              <label>
                Prompt
                <textarea
                  className="task-prompt-input"
                  ref={promptRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onFocus={(event) => ensureFocusedInputVisible(event.target)}
                  enterKeyHint="done"
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canProceedStep1) {
                      event.preventDefault();
                      setStep(2);
                    }
                  }}
                  placeholder="Analyze the repository and fix canonical tag generation."
                  disabled={!project}
                />
              </label>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="mobile-task-section">
              <label>
                Execution mode
                <div className="segmented-control two-up" role="group" aria-label="Execution mode">
                  <button
                    type="button"
                    className={`segment-button ${executionMode === "execute" ? "active" : ""}`}
                    onClick={() => setExecutionMode("execute")}
                    disabled={!project}
                  >
                    Execute
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${executionMode === "plan" ? "active" : ""}`}
                    onClick={() => setExecutionMode("plan")}
                    disabled={!project}
                  >
                    Plan
                  </button>
                </div>
              </label>
              <label>
                Reasoning effort
                <div className="segmented-control" role="group" aria-label="Reasoning effort">
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "low" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("low")}
                    disabled={!project}
                  >
                    Low
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "medium" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("medium")}
                    disabled={!project}
                  >
                    Medium
                  </button>
                  <button
                    type="button"
                    className={`segment-button ${reasoningEffort === "high" ? "active" : ""}`}
                    onClick={() => setReasoningEffort("high")}
                    disabled={!project}
                  >
                    High
                  </button>
                </div>
              </label>
              {profiles.length > 0 ? (
                <label>
                  Profile
                  <select
                    aria-label="Profile"
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    disabled={!project}
                  >
                    <option value="">No profile</option>
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {profileControlsModel ? (
                <label>
                  Model
                  <div className="model-picker-button" aria-label="Model" title="Model is set by the selected profile">
                    {selectedProfileOption?.model} (from profile)
                  </div>
                </label>
              ) : (
                <label>
                  Model
                  <button
                    type="button"
                    className="model-picker-button"
                    onClick={() => setModelSheetOpen(true)}
                    disabled={!project || modelsLoading}
                    aria-label="Model"
                  >
                    {model || (modelsLoading ? "Loading runtime models..." : "Select model")}
                  </button>
                </label>
              )}
              {modelsError ? <p role="alert">{modelsError}</p> : null}
              {executionMode === "plan" ? (
                <p>Plan mode checks Codex runtime collaboration capability and streams planning steps into the event log.</p>
              ) : null}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="mobile-task-section">
              <div className="review-field">
                <span className="meta-label">Title</span>
                <strong className="break-value">{title || "-"}</strong>
              </div>
              <div className="review-field review-field-prompt">
                <span className="meta-label">Prompt</span>
                <p className={`review-prompt ${!promptExpanded ? "collapsed" : ""}`}>
                  {(promptExpanded ? prompt : promptPreview) || "-"}
                </p>
                {prompt.trim().length > 0 ? (
                  <button type="button" className="secondary review-expand-button" onClick={() => setPromptExpanded((previous) => !previous)}>
                    {promptExpanded ? "Collapse" : "Show full prompt"}
                  </button>
                ) : null}
              </div>
              <div className="review-field">
                <span className="meta-label">Execution mode</span>
                <strong>{executionMode}</strong>
              </div>
              <div className="review-field">
                <span className="meta-label">Reasoning effort</span>
                <strong>{reasoningEffort}</strong>
              </div>
              <div className="review-field">
                <span className="meta-label">Model</span>
                <strong className="break-value mono">
                  {(profileControlsModel ? selectedProfileOption?.model : model) || "-"}
                </strong>
              </div>
              {profiles.length > 0 ? (
                <div className="review-field">
                  <span className="meta-label">Profile</span>
                  <strong className="break-value mono">{profile || "-"}</strong>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {modelSheetOpen ? (
          <div className="bottom-sheet-backdrop" onClick={() => setModelSheetOpen(false)}>
            <div
              className="bottom-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Select model"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="bottom-sheet-header">
                <h3>Select model</h3>
                <button type="button" className="secondary" onClick={() => setModelSheetOpen(false)}>
                  Close
                </button>
              </div>
              <div className="bottom-sheet-list">
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`bottom-sheet-option ${model === item.id ? "active" : ""}`}
                    onClick={() => {
                      setModel(item.id);
                      setModelSheetOpen(false);
                    }}
                  >
                    {item.id}
                  </button>
                ))}
                {!modelsLoading && models.length === 0 ? <p className="empty-state">No runtime models available.</p> : null}
              </div>
            </div>
          </div>
        ) : null}

        <div className="mobile-task-sticky-cta" style={{ bottom: `${viewportInset}px` }}>
          {step === 1 ? (
            <button type="button" onClick={() => setStep(2)} disabled={!canProceedStep1}>
              Next
            </button>
          ) : null}
          {step === 2 ? (
            <>
              <button type="button" className="secondary" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" onClick={() => setStep(3)} disabled={!canProceedStep2}>
                Next
              </button>
            </>
          ) : null}
          {step === 3 ? (
            <button type="submit" disabled={!canSubmit}>
              Create Task
            </button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        submitTask();
      }}
    >
      <div className="panel-header">
        <h2>Task Workspace</h2>
        <p>Create an isolated task workspace for the selected project.</p>
      </div>
      <label>
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Fix sitemap canonical"
          disabled={!project}
        />
      </label>
      <label>
        Prompt
        <textarea
          className="task-prompt-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Analyze the repository and fix canonical tag generation."
          disabled={!project}
        />
      </label>
      <label>
        Execution mode
        <select
          aria-label="Execution mode"
          value={executionMode}
          onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}
          disabled={!project}
        >
          <option value="execute">Execute</option>
          <option value="plan">Plan</option>
        </select>
      </label>
      <label>
        Reasoning effort
        <select
          aria-label="Reasoning effort"
          value={reasoningEffort}
          onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
          disabled={!project}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      {profiles.length > 0 ? (
        <label>
          Profile
          <select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value)} disabled={!project}>
            <option value="">No profile</option>
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {profileControlsModel ? (
        <label>
          Model
          <input aria-label="Model" value={`${selectedProfileOption?.model} (from profile)`} disabled readOnly />
        </label>
      ) : (
        <label>
          Model
          <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} disabled={!project || modelsLoading}>
            <option value="">Select model</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {modelsLoading ? <p>Loading runtime models...</p> : null}
      {modelsError ? <p role="alert">{modelsError}</p> : null}
      {executionMode === "plan" ? (
        <p>Plan mode checks Codex runtime collaboration capability and streams planning steps into the event log.</p>
      ) : null}
      <button type="submit" disabled={!canSubmit}>
        Create task
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
    </form>
  );
}

function Modal({
  title,
  open,
  onClose,
  fullScreenMobile = false,
  isMobile = false,
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  fullScreenMobile?: boolean;
  isMobile?: boolean;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }
  const mobileFullScreen = fullScreenMobile && isMobile;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal-card ${mobileFullScreen ? "modal-card-mobile-full" : ""}`}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="secondary modal-close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RunActionSheet({
  open,
  action,
  defaultModel,
  defaultExecutionMode,
  models,
  onClose,
  onConfirm
}: {
  open: boolean;
  action: RunExecutionAction | null;
  defaultModel: string;
  defaultExecutionMode: ExecutionMode;
  models: string[];
  onClose: () => void;
  onConfirm: (config: { model: string; executionMode: ExecutionMode }) => void;
}) {
  const [model, setModel] = useState(defaultModel);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(defaultExecutionMode);

  useEffect(() => {
    if (!open) {
      return;
    }
    setModel(defaultModel);
    setExecutionMode(defaultExecutionMode);
  }, [open, defaultModel, defaultExecutionMode]);

  useEffect(() => {
    if (!models.includes(model)) {
      setModel(models[0] ?? "");
    }
  }, [model, models]);

  if (!open || !action) {
    return null;
  }

  const confirmLabel = action === "run_again" ? "Run again" : "Retry";
  const canConfirm = Boolean(model);

  return (
    <div className="bottom-sheet-backdrop" onClick={onClose}>
      <div className="bottom-sheet" role="dialog" aria-modal="true" aria-label={confirmLabel} onClick={(event) => event.stopPropagation()}>
        <div className="bottom-sheet-header">
          <h3>{confirmLabel}</h3>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="bottom-sheet-list">
          <label className="retry-model-control retry-model-control-mobile">
            Model
            <select aria-label="Retry model" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.length === 0}>
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="retry-model-control retry-model-control-mobile">
            Execution mode
            <div className="segmented-control two-up" role="group" aria-label="Execution mode">
              <button
                type="button"
                className={`segment-button ${executionMode === "execute" ? "active" : ""}`}
                onClick={() => setExecutionMode("execute")}
              >
                Execute
              </button>
              <button
                type="button"
                className={`segment-button ${executionMode === "plan" ? "active" : ""}`}
                onClick={() => setExecutionMode("plan")}
              >
                Plan
              </button>
            </div>
          </label>
          <button type="button" onClick={() => onConfirm({ model, executionMode })} disabled={!canConfirm}>
            Confirm {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [responseDraft, setResponseDraft] = useState<Record<string, string>>({});
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>("conversations");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [mobileDetailTab, setMobileDetailTab] = useState<"log" | "diff">("log");
  const [mobilePromptExpanded, setMobilePromptExpanded] = useState(false);
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Record<string, boolean>>({});
  const [planCopyState, setPlanCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [promptCopyState, setPromptCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [runActionModel, setRunActionModel] = useState("");
  const [runActionSheetOpen, setRunActionSheetOpen] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<RunExecutionAction | null>(null);
  const [pendingExecutionMode, setPendingExecutionMode] = useState<ExecutionMode>("execute");
  const [commitMessage, setCommitMessage] = useState("Apply Task Workspace updates");
  const [gitActionMessage, setGitActionMessage] = useState<string | null>(null);
  const [followupDraft, setFollowupDraft] = useState("");
  const isMobile = useIsMobileBreakpoint();

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects
  });

  const runtimeModelsQuery = useQuery({
    queryKey: ["runtime-models"],
    queryFn: api.listRuntimeModels,
    staleTime: 0
  });

  const runtimeProfilesQuery = useQuery({
    queryKey: ["runtime-profiles"],
    queryFn: api.listRuntimeProfiles,
    staleTime: 5 * 60 * 1000
  });

  const selectedProject = useMemo(
    () => projectsQuery.data?.find((project) => project.id === selectedProjectId) ?? null,
    [projectsQuery.data, selectedProjectId]
  );

  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => api.listTasks(selectedProjectId!),
    enabled: Boolean(selectedProjectId)
  });

  const taskDetailQuery = useQuery({
    queryKey: ["task", selectedTaskId],
    queryFn: () => api.getTask(selectedTaskId!),
    enabled: Boolean(selectedTaskId)
  });

  const taskEventsQuery = useQuery({
    queryKey: ["task-events", selectedTaskId],
    queryFn: () => api.getEvents(selectedTaskId!),
    enabled: Boolean(selectedTaskId)
  });

  const taskDiffQuery = useQuery({
    queryKey: ["task-diff", selectedTaskId],
    queryFn: () => api.getDiff(selectedTaskId!),
    enabled: Boolean(selectedTaskId)
  });

  useTaskStream(selectedTaskId);

  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: api.listConversations,
    refetchInterval: 5000,
  });

  const createConversationMutation = useMutation({
    mutationFn: (projectId: string) => api.createConversation({ project_id: projectId }),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setSelectedConversationId(conv.id);
      setMobileScreen("conversation-detail");
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteConversation,
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (selectedConversationId === deletedId) {
        setSelectedConversationId(null);
        setMobileScreen("conversations");
      }
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: api.createProject,
    onSuccess: (project) => {
      queryClient.setQueryData(["projects"], (previous: ProjectSummary[] | undefined) => {
        const next = previous ?? [];
        if (next.some((item) => item.id === project.id)) {
          return next;
        }
        return [project, ...next];
      });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setSelectedProjectId(project.id);
      setProjectModalOpen(false);
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: api.createTask,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      setSelectedTaskId(task.id);
      setTaskModalOpen(false);
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: (_, projectId) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.removeQueries({ queryKey: ["tasks", projectId] });
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedTaskId(null);
      }
    }
  });

  const deleteTaskMutation = useMutation({
    mutationFn: api.deleteTask,
    onSuccess: (_, taskId) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", selectedProjectId] });
      queryClient.removeQueries({ queryKey: ["task", taskId] });
      queryClient.removeQueries({ queryKey: ["task-events", taskId] });
      queryClient.removeQueries({ queryKey: ["task-diff", taskId] });
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
    }
  });

  const taskActionMutation = useMutation({
    mutationFn: async (input: { action: "approveTask" | "stopTask" | "retryTask"; taskId: string; model?: string }) => {
      if (input.action === "approveTask") {
        return api.approveTask(input.taskId, { actor });
      }
      if (input.action === "stopTask") {
        return api.stopTask(input.taskId, { actor });
      }
      return api.retryTask(input.taskId, { actor, model: input.model });
    },
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", task.id] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", task.id] });
    }
  });

  const respondMutation = useMutation({
    mutationFn: async (input: { taskId: string; answers: Record<string, string[]> }) =>
      api.respondTask(input.taskId, { actor, answers: input.answers }),
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", task.id] });
      setResponseDraft({});
    }
  });

  const followupMutation = useMutation({
    mutationFn: async (input: { sessionId: string; content: string }) =>
      api.createFollowupTurn(input.sessionId, { content: input.content }),
    onSuccess: (updatedTask) => {
      queryClient.setQueryData(["task", updatedTask.id], updatedTask);
      queryClient.invalidateQueries({ queryKey: ["tasks", updatedTask.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", updatedTask.id] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", updatedTask.id] });
      setFollowupDraft("");
      setMobileDetailTab("log");
    }
  });

  const workspaceCommitMutation = useMutation({
    mutationFn: (input: { taskId: string; message: string }) =>
      api.commitTaskWorkspace(input.taskId, { actor, message: input.message }),
    onSuccess: (result, input) => {
      setGitActionMessage(`Commit succeeded on ${result.branch ?? "branch"}`);
      queryClient.invalidateQueries({ queryKey: ["task-events", input.taskId] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", input.taskId] });
    }
  });

  const workspacePushMutation = useMutation({
    mutationFn: (input: { taskId: string }) =>
      api.pushTaskWorkspace(input.taskId, { actor, remote: "origin", set_upstream: true }),
    onSuccess: (result, input) => {
      setGitActionMessage(`Push succeeded: ${result.remote ?? "origin"}/${result.branch ?? ""}`);
      queryClient.invalidateQueries({ queryKey: ["task-events", input.taskId] });
    }
  });

  const task = taskDetailQuery.data ?? null;
  const events = taskEventsQuery.data ?? [];
  const diff = taskDiffQuery.data ?? task?.latest_diff;
  const runActionModelOptions = useMemo(() => {
    const ids = runtimeModelsQuery.data?.models.map((item) => item.id) ?? [];
    if (task?.model && !ids.includes(task.model)) {
      return [task.model, ...ids];
    }
    return ids;
  }, [runtimeModelsQuery.data?.models, task?.model]);
  const latestPlan = useMemo(() => extractLatestPlan(events), [events]);
  const planMarkdown = useMemo(() => {
    if (!latestPlan) {
      return "";
    }
    const sections: string[] = [];
    if (latestPlan.explanation) {
      sections.push(latestPlan.explanation);
    }
    if (latestPlan.steps.length > 0) {
      sections.push(
        ["## Plan steps", ...latestPlan.steps.map((step, idx) => `${idx + 1}. **${step.step}** - ${step.status}`)].join("\n")
      );
    }
    if (latestPlan.text) {
      sections.push(latestPlan.text);
    }
    return sections.join("\n\n");
  }, [latestPlan]);

  const handleDeleteProject = () => {
    if (!selectedProject) {
      return;
    }
    if (!window.confirm("Delete this project?")) {
      return;
    }
    deleteProjectMutation.mutate(selectedProject.id);
  };

  useEffect(() => {
    if (!task || task.status !== "waiting_user_input") {
      setResponseDraft({});
      return;
    }
    setResponseDraft((previous) => {
      const next = defaultAnswers(task.pending_questions);
      for (const question of task.pending_questions) {
        if (previous[question.id] !== undefined) {
          next[question.id] = previous[question.id];
        }
      }
      return next;
    });
  }, [task]);

  useEffect(() => {
    if (!task) {
      setRunActionModel("");
      setPendingRunAction(null);
      setRunActionSheetOpen(false);
      setCommitMessage("Apply Task Workspace updates");
      setGitActionMessage(null);
      return;
    }
    if (task.model && runActionModelOptions.includes(task.model)) {
      setRunActionModel(task.model);
    } else {
      setRunActionModel(runActionModelOptions[0] ?? "");
    }
    setPendingRunAction(null);
    setRunActionSheetOpen(false);
    setPendingExecutionMode(task.execution_mode ?? "execute");
    setCommitMessage(`Apply updates for ${task.title}`);
    setGitActionMessage(null);
    setFollowupDraft("");
  }, [task, runActionModelOptions]);

  useEffect(() => {
    if (!isMobile) {
      setMobileScreen("conversations");
    }
  }, [isMobile]);

  const isHandlingPopState = useRef(false);

  // Push a history entry each time the mobile screen changes
  useEffect(() => {
    if (!isMobile) return;
    if (isHandlingPopState.current) {
      isHandlingPopState.current = false;
      return;
    }
    window.history.pushState({ mobileScreen }, "");
  }, [mobileScreen, isMobile]);

  // Handle browser back button on mobile
  useEffect(() => {
    if (!isMobile) return;
    const BACK_MAP: Partial<Record<MobileScreen, MobileScreen>> = {
      "conversation-detail": "conversations",
      "projects": "conversations",
      "project-prompts": "projects",
      "tasks": "projects",
      "detail": "tasks",
    };
    const handlePopState = (e: PopStateEvent) => {
      const prevScreen = (e.state as { mobileScreen?: MobileScreen } | null)?.mobileScreen;
      const target = prevScreen ?? BACK_MAP[mobileScreen] ?? "conversations";
      isHandlingPopState.current = true;
      setMobileScreen(target);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile, mobileScreen]);

  useEffect(() => {
    setMobileDetailTab("log");
    setMobilePromptExpanded(false);
    setExpandedDiffFiles({});
  }, [task?.id]);

  const copyToClipboard = async (content: string): Promise<boolean> => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        return true;
      }
      if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const copyPlanOutput = async () => {
    const content = planMarkdown || "Latest implementation plan from Codex runtime.";
    const copied = await copyToClipboard(content);
    if (copied) {
      setPlanCopyState("copied");
    } else {
      setPlanCopyState("error");
    }
    window.setTimeout(() => setPlanCopyState("idle"), 1500);
  };

  const copyPromptOutput = async () => {
    if (!task) {
      return;
    }
    const copied = await copyToClipboard(task.prompt);
    if (copied) {
      setPromptCopyState("copied");
    } else {
      setPromptCopyState("error");
    }
    window.setTimeout(() => setPromptCopyState("idle"), 1500);
  };

  const handleRunActionConfirm = (config: { model: string; executionMode: ExecutionMode }) => {
    if (!task || !pendingRunAction) {
      return;
    }
    if (typeof window !== "undefined" && config.model) {
      window.localStorage.setItem(LAST_TASK_MODEL_KEY, config.model);
    }
    setRunActionModel(config.model);
    setPendingExecutionMode(config.executionMode);
    setRunActionSheetOpen(false);
    setPendingRunAction(null);
    taskActionMutation.mutate({ action: "retryTask", taskId: task.id, model: config.model || undefined });
  };

  const handleSendFollowup = () => {
    if (!task) {
      return;
    }
    const message = followupDraft.trim();
    if (!message) {
      return;
    }
    followupMutation.mutate({ sessionId: task.session_id, content: message });
  };

  const renderTaskDetailContent = (mobile: boolean) => {
    if (!task) {
      return <p className="empty-state">Select a task to inspect the Task Workspace and approval state.</p>;
    }

    const runStatus = inferRunStatus(task.status);
    const runStatusLabel = getRunStatusLabel(runStatus);
    const primaryAction = getPrimaryAction(runStatus);
    const secondaryActions = getSecondaryActions(runStatus);
    const canApprove = task.status === "waiting_result_approval";
    const canStop = !["completed", "failed", "stopped"].includes(task.status);
    const canRunWithSelectedModel = runActionModelOptions.length > 0;
    const promptPreview = task.prompt.replace(/\s+/g, " ").trim();
    const compactPromptPreview =
      promptPreview.length > 180 ? `${promptPreview.slice(0, 180).trimEnd()}...` : promptPreview || "No prompt";
    const latestRunTimestamp = (events.length > 0 ? events[events.length - 1]?.created_at : null) ?? task.updated_at;
    const followupDisabled = runStatus === "running" || task.status === "waiting_result_approval" || task.status === "waiting_user_input";

    const triggerRunAction = (action: RunExecutionAction) => {
      setPendingRunAction(action);
      setRunActionSheetOpen(true);
    };

    const handlePrimaryAction = () => {
      if (primaryAction.key === "stop") {
        taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
        return;
      }
      if (primaryAction.key === "approve") {
        taskActionMutation.mutate({ action: "approveTask", taskId: task.id });
        return;
      }
      if (!mobile) {
        taskActionMutation.mutate({
          action: "retryTask",
          taskId: task.id,
          model: runActionModel || undefined
        });
        return;
      }
      triggerRunAction(primaryAction.key);
    };

    const isPrimaryDisabled =
      primaryAction.key === "stop"
        ? !canStop
        : primaryAction.key === "approve"
          ? !canApprove
          : !canRunWithSelectedModel;

    if (mobile) {
      return (
        <>
          <div className={`mobile-detail-control mobile-detail-control-${runStatus}`}>
            <div className="mobile-detail-control-top">
              <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("tasks")}>
                Back
              </button>
              <strong className="truncate">{task.title}</strong>
              <StatusBadge status={task.status} />
            </div>
            <div className="mobile-detail-action-row">
              <button
                type="button"
                className={primaryAction.intent === "danger" ? "status-action-danger" : ""}
                onClick={handlePrimaryAction}
                disabled={isPrimaryDisabled}
              >
                {primaryAction.label}
              </button>
              {secondaryActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (action.key === "reject") {
                      taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
                      return;
                    }
                    setFollowupDraft("Please revise this result with tighter spacing.");
                    setMobileDetailTab("log");
                  }}
                  disabled={action.key === "reject" ? !canStop : followupDisabled}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          <section className="mobile-run-context">
            <h3>Run context</h3>
            <p>
              <strong>{runStatusLabel}</strong>
            </p>
            <p>Last run: {getRunResultLabel(runStatus)}</p>
            <p>{formatRelativeTime(latestRunTimestamp)}</p>
          </section>

          <details className="mobile-meta-section" open>
            <summary>Summary</summary>
            <div className="meta-grid mobile-meta-grid">
              <div>
                <span className="meta-label">Project</span>
                <strong className="break-value">{task.project?.name ?? "Unknown project"}</strong>
              </div>
              <div>
                <span className="meta-label">Model (effective)</span>
                <strong className="break-value mono">{task.effective_model ?? task.model ?? "Unknown"}</strong>
              </div>
              {task.profile ? (
                <div>
                  <span className="meta-label">Profile</span>
                  <strong className="break-value mono">{task.profile}</strong>
                </div>
              ) : null}
              <div>
                <span className="meta-label">Execution mode</span>
                <strong className="break-value">{task.execution_mode}</strong>
              </div>
              <div>
                <span className="meta-label">Reasoning</span>
                <strong className="break-value">{task.reasoning_effort ?? "medium"}</strong>
              </div>
            </div>
          </details>

          <div className="mobile-detail-tabs" role="tablist" aria-label="Task detail tabs">
            <button
              type="button"
              className={mobileDetailTab === "log" ? "active" : ""}
              role="tab"
              aria-selected={mobileDetailTab === "log"}
              onClick={() => setMobileDetailTab("log")}
            >
              Log
            </button>
            <button
              type="button"
              className={mobileDetailTab === "diff" ? "active" : ""}
              role="tab"
              aria-selected={mobileDetailTab === "diff"}
              onClick={() => setMobileDetailTab("diff")}
            >
              Diff
            </button>
          </div>

          <div className="mobile-detail-tab-panel">
            {mobileDetailTab === "log" ? (
              <div className="mobile-log-scroll">
                {latestPlan ? (
                  <section className="output-panel">
                    <div className="row-header">
                      <h3>Plan output</h3>
                      <button type="button" className="secondary" onClick={copyPlanOutput}>
                        Copy plan
                      </button>
                    </div>
                    {planCopyState === "copied" ? <p className="copy-status">Copied to clipboard.</p> : null}
                    {planCopyState === "error" ? <p className="copy-status">Copy failed.</p> : null}
                    <div className="plan-output">
                      <MarkdownRenderer markdown={planMarkdown || "Latest implementation plan from Codex runtime."} />
                    </div>
                  </section>
                ) : null}

                <section className="output-panel">
                  <div className="row-header">
                    <h3>Event log</h3>
                  </div>
                  <StructuredLogTab events={events} mobile />
                  <SessionComposer
                    value={followupDraft}
                    onChange={setFollowupDraft}
                    onSend={handleSendFollowup}
                    disabled={followupDisabled}
                    pending={followupMutation.isPending}
                  />
                  {followupMutation.error instanceof Error ? <p role="alert">{followupMutation.error.message}</p> : null}
                </section>
              </div>
            ) : (
              <section className="output-panel mobile-diff-scroll">
                <div className="row-header">
                  <h3>Diff</h3>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => workspaceCommitMutation.mutate({ taskId: task.id, message: commitMessage.trim() })}
                      disabled={!task.workspace_path || !commitMessage.trim() || workspaceCommitMutation.isPending}
                    >
                      Commit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => workspacePushMutation.mutate({ taskId: task.id })}
                      disabled={!task.workspace_path || workspacePushMutation.isPending}
                    >
                      Push
                    </button>
                  </div>
                </div>
                <label className="retry-model-control retry-model-control-mobile">
                  Commit message
                  <input
                    aria-label="Commit message"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Apply Task Workspace updates"
                  />
                </label>
                {workspaceCommitMutation.error instanceof Error ? <p role="alert">{workspaceCommitMutation.error.message}</p> : null}
                {workspacePushMutation.error instanceof Error ? <p role="alert">{workspacePushMutation.error.message}</p> : null}
                {gitActionMessage ? <p className="copy-status">{gitActionMessage}</p> : null}
                <p>{diff?.summary && diff.summary.trim().length > 0 ? diff.summary : "Waiting for runtime diff."}</p>
                {diff?.raw_diff ? (
                  <GroupedDiff
                    rawDiff={diff.raw_diff}
                    filesChanged={diff.files_changed}
                    expanded={expandedDiffFiles}
                    onToggle={(id) =>
                      setExpandedDiffFiles((previous) => ({
                        ...previous,
                        [id]: !previous[id]
                      }))
                    }
                  />
                ) : (
                  <ul>
                    {diff?.files_changed.map((file: string) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          <section className="mobile-prompt-section">
            <div className="output-panel prompt-output">
              <div className="row-header">
                <h3>Input prompt</h3>
                {!mobilePromptExpanded ? (
                  <button type="button" className="secondary" onClick={() => setMobilePromptExpanded(true)}>
                    Expand
                  </button>
                ) : (
                  <div className="inline-actions">
                    <button type="button" className="secondary" onClick={() => setMobilePromptExpanded(false)}>
                      Collapse
                    </button>
                    <button type="button" className="secondary" onClick={copyPromptOutput}>
                      Copy
                    </button>
                  </div>
                )}
              </div>
              {mobilePromptExpanded ? (
                <>
                  {promptCopyState === "copied" ? <p className="copy-status">Prompt copied to clipboard.</p> : null}
                  {promptCopyState === "error" ? <p className="copy-status">Prompt copy failed.</p> : null}
                  <MarkdownRenderer markdown={task.prompt} />
                </>
              ) : (
                <p className="mobile-prompt-preview">{compactPromptPreview}</p>
              )}
            </div>
          </section>
        </>
      );
    }

    return (
      <>
        <div className="meta-grid">
          <div>
            <span className="meta-label">Project</span>
            <strong className="break-value">{task.project?.name ?? "Unknown project"}</strong>
          </div>
          <div>
            <span className="meta-label">Execution mode</span>
            <strong className="break-value">{task.execution_mode}</strong>
          </div>
          <div>
            <span className="meta-label">Effective model</span>
            <strong className="break-value mono">{task.effective_model ?? "Unknown"}</strong>
          </div>
          {task.profile ? (
            <div>
              <span className="meta-label">Profile</span>
              <strong className="break-value mono">{task.profile}</strong>
            </div>
          ) : null}
          <div>
            <span className="meta-label">Reasoning effort</span>
            <strong className="break-value">{task.reasoning_effort ?? "medium"}</strong>
          </div>
          <div>
            <span className="meta-label">Task Workspace</span>
            <strong className="break-value mono">{task.workspace_ref}</strong>
            <span className="break-value mono">{task.workspace_path}</span>
          </div>
          <div>
            <span className="meta-label">Runtime session</span>
            <strong className="break-value mono">{task.runtime_session_id ?? "Not started"}</strong>
          </div>
        </div>

        <div className="action-row">
          <label className="retry-model-control">
            Retry model
            <select
              aria-label="Retry model"
              value={runActionModel}
              onChange={(event) => setRunActionModel(event.target.value)}
              disabled={runActionModelOptions.length === 0}
            >
              {runActionModelOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="retry-model-control">
            Commit message
            <input
              aria-label="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Apply Task Workspace updates"
            />
          </label>
          <button
            type="button"
            className={primaryAction.intent === "danger" ? "status-action-danger" : ""}
            onClick={handlePrimaryAction}
            disabled={isPrimaryDisabled}
          >
            {primaryAction.label}
          </button>
          {secondaryActions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="secondary"
              onClick={() => {
                if (action.key === "reject") {
                  taskActionMutation.mutate({ action: "stopTask", taskId: task.id });
                  return;
                }
                setFollowupDraft("Please revise this result with tighter spacing.");
              }}
              disabled={action.key === "reject" ? !canStop : followupDisabled}
            >
              {action.label}
            </button>
          ))}
          <button
            className="secondary"
            onClick={() => workspaceCommitMutation.mutate({ taskId: task.id, message: commitMessage.trim() })}
            disabled={!task.workspace_path || !commitMessage.trim() || workspaceCommitMutation.isPending}
          >
            Commit
          </button>
          <button
            className="secondary"
            onClick={() => workspacePushMutation.mutate({ taskId: task.id })}
            disabled={!task.workspace_path || workspacePushMutation.isPending}
          >
            Push
          </button>
        </div>
        <section className="run-context-panel">
          <h3>Run context</h3>
          <p>
            <strong>{runStatusLabel}</strong>
          </p>
          <p>Last run: {getRunResultLabel(runStatus)}</p>
          <p>{formatRelativeTime(latestRunTimestamp)}</p>
        </section>
        {workspaceCommitMutation.error instanceof Error ? <p role="alert">{workspaceCommitMutation.error.message}</p> : null}
        {workspacePushMutation.error instanceof Error ? <p role="alert">{workspacePushMutation.error.message}</p> : null}
        {gitActionMessage ? <p className="copy-status">{gitActionMessage}</p> : null}

        {task.status === "waiting_user_input" ? (
          <section className="panel form-panel">
            <div className="panel-header">
              <h3>User input required</h3>
              <p>Codex App Server paused the task and is waiting for structured input.</p>
            </div>
            {task.pending_questions.map((question) => (
              <label key={question.id}>
                {question.header || question.question}
                <span>{question.question}</span>
                {question.options?.length ? (
                  <small>
                    Options:{" "}
                    {question.options
                      .map((option) => option.label)
                      .filter(Boolean)
                      .join(", ")}
                  </small>
                ) : null}
                <input
                  aria-label={question.header || question.question}
                  type={question.is_secret ? "password" : "text"}
                  value={responseDraft[question.id] ?? ""}
                  onChange={(event) =>
                    setResponseDraft((previous) => ({ ...previous, [question.id]: event.target.value }))
                  }
                />
              </label>
            ))}
            <button
              onClick={() =>
                respondMutation.mutate({
                  taskId: task.id,
                  answers: Object.fromEntries(
                    Object.entries(responseDraft).map(([questionId, value]) => [questionId, value ? [value] : []])
                  )
                })
              }
              disabled={respondMutation.isPending || task.pending_questions.length === 0}
            >
              Send response
            </button>
          </section>
        ) : null}

        <div className="output-stack">
          <section>
            <div className="row-header">
              <h3>Input prompt</h3>
              <button type="button" className="secondary" onClick={copyPromptOutput}>
                Copy prompt
              </button>
            </div>
            {promptCopyState === "copied" ? <p className="copy-status">Prompt copied to clipboard.</p> : null}
            {promptCopyState === "error" ? <p className="copy-status">Prompt copy failed.</p> : null}
            <div className="output-panel prompt-output">
              <MarkdownRenderer markdown={task.prompt} />
            </div>
          </section>

          {latestPlan ? (
            <section>
              <div className="row-header">
                <h3>Plan output</h3>
                <button type="button" className="secondary" onClick={copyPlanOutput}>
                  Copy plan
                </button>
              </div>
              {planCopyState === "copied" ? <p className="copy-status">Copied to clipboard.</p> : null}
              {planCopyState === "error" ? <p className="copy-status">Copy failed.</p> : null}
              <div className="output-panel plan-output">
                <MarkdownRenderer markdown={planMarkdown || "Latest implementation plan from Codex runtime."} />
              </div>
            </section>
          ) : null}

          <section>
            <h3>Event log</h3>
            <div className="output-panel">
              <StructuredLogTab events={events} mobile={false} />
              <SessionComposer
                value={followupDraft}
                onChange={setFollowupDraft}
                onSend={handleSendFollowup}
                disabled={followupDisabled}
                pending={followupMutation.isPending}
              />
              {followupMutation.error instanceof Error ? <p role="alert">{followupMutation.error.message}</p> : null}
            </div>
          </section>

          <section>
            <h3>Diff summary</h3>
            <div className="output-panel">
              <p>{diff?.summary && diff.summary.trim().length > 0 ? diff.summary : "Waiting for runtime diff."}</p>
              {diff?.raw_diff ? (
                <GroupedDiff
                  rawDiff={diff.raw_diff}
                  filesChanged={diff.files_changed}
                  expanded={expandedDiffFiles}
                  onToggle={(id) =>
                    setExpandedDiffFiles((previous) => ({
                      ...previous,
                      [id]: !previous[id]
                    }))
                  }
                />
              ) : (
                <ul>
                  {diff?.files_changed.map((file: string) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </>
    );
  };

  return (
    <div className="app-shell">
      <header className={isMobile ? "commander-header mobile-header" : "commander-header"}>
        <div className="header-copy">
          <p className="eyebrow">Web Commander</p>
          <h1>Agent Supervision Console</h1>
          <p className="hero-copy">Projects, tasks, and runtime detail in one stable control plane layout.</p>
        </div>
        <div className={isMobile ? "header-actions hidden-on-mobile" : "header-actions"}>
          <button type="button" onClick={() => setProjectModalOpen(true)}>
            New Project
          </button>
          <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
            New Task
          </button>
        </div>
      </header>

      {isMobile ? (
        <main className="mobile-shell">
          {mobileScreen === "conversations" ? (
            <ConversationListScreen
              conversations={conversationsQuery.data ?? []}
              projects={projectsQuery.data ?? []}
              isLoading={conversationsQuery.isLoading}
              onSelect={(id) => {
                setSelectedConversationId(id);
                setMobileScreen("conversation-detail");
              }}
              onCreate={(projectId) => createConversationMutation.mutate(projectId)}
              onDelete={(id) => deleteConversationMutation.mutate(id)}
              onManageProjects={() => setMobileScreen("projects")}
            />
          ) : null}

          {mobileScreen === "conversation-detail" && selectedConversationId ? (
            <ConversationDetailScreen
              conversationId={selectedConversationId}
              onBack={() => setMobileScreen("conversations")}
            />
          ) : null}

          {mobileScreen === "projects" ? (
            <section className="panel mobile-screen">
              <div className="panel-header">
                <div className="row-header">
                  <div>
                    <div className="mobile-title-row">
                      <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("conversations")}>
                        Back
                      </button>
                      <h2>Projects</h2>
                    </div>
                  </div>
                  <div className="inline-actions">
                    <button type="button" onClick={() => setProjectModalOpen(true)}>
                      New Project
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleDeleteProject}
                      disabled={!selectedProject || deleteProjectMutation.isPending}
                    >
                      {deleteProjectMutation.isPending ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="panel-scroll">
                {projectsQuery.data?.length ? (
                  projectsQuery.data.map((project) => (
                    <div
                      key={project.id}
                      className={project.id === selectedProjectId ? "list-item active" : "list-item"}
                      style={{ display: "flex", alignItems: "center", gap: "8px" }}
                      title={project.repo_path}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedProjectId(project.id);
                          setSelectedTaskId(null);
                          setMobileScreen("tasks");
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "inherit",
                          font: "inherit",
                          cursor: "pointer",
                        }}
                      >
                        <strong>{project.name}</strong>
                        <span className="item-secondary truncate">{project.repo_path}</span>
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        style={{ flexShrink: 0, fontSize: "0.78rem", padding: "4px 10px" }}
                        onClick={() => {
                          setSelectedProjectId(project.id);
                          setMobileScreen("project-prompts");
                        }}
                      >
                        Prompts
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="empty-state">No projects yet.</p>
                )}
              </div>
            </section>
          ) : null}

          {mobileScreen === "project-prompts" ? (
            <ProjectPromptsScreen
              project={selectedProject}
              onBack={() => setMobileScreen("projects")}
            />
          ) : null}

          {mobileScreen === "tasks" ? (
            <section className="panel mobile-screen">
              <div className="panel-header mobile-title-row">
                <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("projects")}>
                  Back
                </button>
                <div>
                  <h2>Tasks</h2>
                  <p>{selectedProject?.name ?? "Select project"}</p>
                </div>
                <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
                  New Task
                </button>
              </div>
              <div className="panel-scroll">
                {selectedProject ? (
                  tasksQuery.data?.length ? (
                    tasksQuery.data.map((item) => (
                      <button
                        key={item.id}
                        className={item.id === selectedTaskId ? "task-row active" : "task-row"}
                        onClick={() => {
                          setSelectedTaskId(item.id);
                          setMobileScreen("detail");
                        }}
                        title={item.workspace_path ?? item.workspace_ref}
                      >
                        <div className="list-row">
                          <strong className="truncate">{item.title}</strong>
                          <StatusBadge status={item.status} />
                        </div>
                        <div className="task-meta-row">
                          <span className="item-secondary">{item.execution_mode}</span>
                          <span className="item-secondary mono truncate">{item.workspace_ref}</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <p className="empty-state">No tasks yet for this project.</p>
                  )
                ) : (
                  <p className="empty-state">Select a project first.</p>
                )}
              </div>
            </section>
          ) : null}

          {mobileScreen === "detail" ? (
            <section className="panel mobile-screen detail-panel mobile-detail-screen">
              {renderTaskDetailContent(true)}
            </section>
          ) : null}
        </main>
      ) : (
        <main className="workspace-grid">
          <section className="panel sidebar">
            <div className="panel-header">
              <div className="row-header">
                <div>
                  <h2>Projects</h2>
                  <p>Connected repositories</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleDeleteProject}
                  disabled={!selectedProject || deleteProjectMutation.isPending}
                >
                  {deleteProjectMutation.isPending ? "Deleting..." : "Delete Project"}
                </button>
              </div>
            </div>
            <div className="panel-scroll">
              {projectsQuery.data?.length ? (
                projectsQuery.data.map((project) => (
                  <button
                    key={project.id}
                    className={project.id === selectedProjectId ? "list-item active" : "list-item"}
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setSelectedTaskId(null);
                    }}
                    title={project.repo_path}
                    >
                      <strong>{project.name}</strong>
                      <span className="item-secondary truncate">{project.repo_path}</span>
                    </button>
                  ))
              ) : (
                <p className="empty-state">No projects yet. Create one from New Project.</p>
              )}
            </div>
          </section>

          <section className="panel tasks-panel">
            <div className="panel-header">
              <div className="row-header">
                <div>
                  <h2>Tasks</h2>
                  <p>{selectedProject ? selectedProject.name : "Select a project first"}</p>
                </div>
                <div className="row-header-actions">
                  <button
                    type="button"
                    className="btn-danger-sm"
                    disabled={!selectedTaskId}
                    onClick={() => {
                      if (selectedTaskId && window.confirm("Delete this task?")) {
                        deleteTaskMutation.mutate(selectedTaskId);
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
                    + New Task
                  </button>
                </div>
              </div>
            </div>
            <div className="panel-scroll">
              {selectedProject ? (
                tasksQuery.data?.length ? (
                  tasksQuery.data.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === selectedTaskId ? "task-row active" : "task-row"}
                      onClick={() => setSelectedTaskId(item.id)}
                      title={item.workspace_path ?? item.workspace_ref}
                    >
                      <div className="list-row">
                        <strong className="truncate">{item.title}</strong>
                        <StatusBadge status={item.status} />
                      </div>
                      <div className="task-meta-row">
                        <span className="item-secondary">{item.execution_mode}</span>
                        <span className="item-secondary mono truncate">{item.workspace_ref}</span>
                      </div>
                      <span className="item-secondary mono truncate">{item.workspace_path ?? "workspace pending"}</span>
                    </button>
                  ))
                ) : (
                  <p className="empty-state">No tasks yet for this project.</p>
                )
              ) : (
                <p className="empty-state">Select a project to browse tasks.</p>
              )}
            </div>
          </section>

          <section className="panel detail-panel">
            <div className="panel-header">
              <div>
                <h2>Task Detail</h2>
                <p>Orchestration API view into the active Codex App Server session.</p>
              </div>
              {task ? <StatusBadge status={task.status} /> : null}
            </div>
            <div className="detail-scroll">
              {renderTaskDetailContent(false)}
            </div>
          </section>
        </main>
      )}

      <RunActionSheet
        open={runActionSheetOpen}
        action={pendingRunAction}
        defaultModel={runActionModel}
        defaultExecutionMode={pendingExecutionMode}
        models={runActionModelOptions}
        onClose={() => {
          setRunActionSheetOpen(false);
          setPendingRunAction(null);
        }}
        onConfirm={handleRunActionConfirm}
      />

      <Modal title="New Project" open={projectModalOpen} onClose={() => setProjectModalOpen(false)} isMobile={isMobile}>
        <ProjectForm onCreate={(payload) => createProjectMutation.mutate(payload)} onClose={() => setProjectModalOpen(false)} />
      </Modal>

      <Modal
        title="New Task"
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        fullScreenMobile
        isMobile={isMobile}
      >
        <TaskForm
          project={selectedProject}
          models={runtimeModelsQuery.data?.models ?? []}
          modelsLoading={runtimeModelsQuery.isLoading}
          modelsError={runtimeModelsQuery.error instanceof Error ? runtimeModelsQuery.error.message : null}
          profiles={runtimeProfilesQuery.data?.profiles ?? []}
          isMobile={isMobile}
          onCreate={(payload) => createTaskMutation.mutate(payload)}
          onClose={() => setTaskModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
