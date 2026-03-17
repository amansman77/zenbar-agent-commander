import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProjectRequest,
  CreateTaskRequest,
  DiscoverProjectResponse,
  ExecutionMode,
  ReasoningEffort,
  RuntimeModelOption,
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
type MobileScreen = "projects" | "tasks" | "detail";
type RunStatus = "running" | "waiting_approval" | "completed" | "failed";
type RunActionIntent = "primary" | "danger";
type RunExecutionAction = "run_again" | "retry";
type RunActionConfig = {
  key: "stop" | "approve" | RunExecutionAction;
  label: string;
  intent: RunActionIntent;
};

type ParsedDiffFile = {
  id: string;
  fileName: string;
  lines: string[];
  additions: number;
  deletions: number;
};

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

function getSecondaryActions(status: RunStatus): Array<{ key: "reject"; label: string }> {
  if (status === "waiting_approval") {
    return [{ key: "reject", label: "Reject" }];
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
  const [fieldOrigin, setFieldOrigin] = useState({
    name: "manual",
    repoPath: "manual",
    defaultBranch: "manual"
  });

  const discoverProjectMutation = useMutation({
    mutationFn: api.discoverProject,
    onSuccess: (project) => {
      setLastDiscovered(project);
      setDiscoveryError(null);
      setName(project.name);
      setRepoPath(project.repo_path);
      setDefaultBranch(project.default_branch);
      setFieldOrigin({
        name: "discovered",
        repoPath: "discovered",
        defaultBranch: "discovered"
      });
    },
    onError: (error: Error) => {
      setDiscoveryError(error.message);
    }
  });

  const canSubmit = Boolean(name.trim() && repoPath.trim() && defaultBranch.trim());

  return (
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
        onClick={() => discoverProjectMutation.mutate({})}
        disabled={discoverProjectMutation.isPending}
      >
        {discoverProjectMutation.isPending ? "Choosing folder..." : "Choose folder"}
      </button>
      {discoveryError ? <p role="alert">{discoveryError}</p> : null}
      {lastDiscovered ? <p>Selected Task Workspace source: {lastDiscovered.repo_path}</p> : null}
      <label>
        Project name
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setFieldOrigin((previous) => ({ ...previous, name: "edited" }));
          }}
        />
      </label>
      <label>
        Repository path
        <input
          value={repoPath}
          onChange={(event) => {
            setRepoPath(event.target.value);
            setFieldOrigin((previous) => ({ ...previous, repoPath: "edited" }));
          }}
        />
      </label>
      <label>
        Default branch
        <input
          value={defaultBranch}
          onChange={(event) => {
            setDefaultBranch(event.target.value);
            setFieldOrigin((previous) => ({ ...previous, defaultBranch: "edited" }));
          }}
        />
      </label>
      <button type="submit" disabled={!canSubmit}>
        Create project
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
      <p>Mode: {lastDiscovered ? "discovered" : "manual"} / name {fieldOrigin.name} / path {fieldOrigin.repoPath}</p>
    </form>
  );
}

function TaskForm({
  project,
  models,
  modelsLoading,
  modelsError,
  isMobile,
  onCreate,
  onClose
}: {
  project: ProjectSummary | null;
  models: RuntimeModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
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
    if (typeof window !== "undefined" && model) {
      window.localStorage.setItem(LAST_TASK_MODEL_KEY, model);
    }
    onCreate({
      project_id: project.id,
      title,
      prompt,
      model,
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
  const canProceedStep2 = Boolean(project && model && models.length > 0 && !modelsLoading);
  const canSubmit = Boolean(project && model && models.length > 0 && !modelsLoading);
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
                <strong className="break-value mono">{model || "-"}</strong>
              </div>
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
            <select aria-label="Run model" value={model} onChange={(event) => setModel(event.target.value)} disabled={models.length === 0}>
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
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>("projects");
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
  const isMobile = useIsMobileBreakpoint();

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects
  });

  const runtimeModelsQuery = useQuery({
    queryKey: ["runtime-models"],
    queryFn: api.listRuntimeModels,
    staleTime: 60_000
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
  }, [task, runActionModelOptions]);

  useEffect(() => {
    if (!isMobile) {
      setMobileScreen("projects");
    }
  }, [isMobile]);

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
    const latestRunTimestamp = events.at(-1)?.created_at ?? task.updated_at;
    const compactEvents = events.filter((event, index, list) => {
      if (event.type !== "agent_status") {
        return true;
      }
      const previous = list[index - 1];
      if (!previous) {
        return true;
      }
      return !(previous.type === "agent_status" && previous.message === event.message);
    });

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
                  onClick={() => taskActionMutation.mutate({ action: "stopTask", taskId: task.id })}
                  disabled={!canStop}
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
                  <ul className="mobile-event-list">
                    {compactEvents.map((event) => {
                      const isImportant = ["failed", "completed", "result_approval_requested", "result_approval_granted", "user_input_requested"].includes(event.type);
                      return (
                        <li key={event.id} className={isImportant ? "event-item-important" : ""}>
                          <span className={`event-icon event-icon-${event.type.includes("error") ? "error" : "normal"}`} aria-hidden="true">
                            ●
                          </span>
                          <div>
                            <p className={`event-message ${event.type === "agent_status" ? "event-message-agent-status" : ""}`}>{event.message}</p>
                            <p className="event-meta">
                              <span>{new Date(event.created_at).toLocaleTimeString()}</span>
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {events.length === 0 ? <p className="empty-state">No events yet.</p> : null}
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
              onClick={() => taskActionMutation.mutate({ action: "stopTask", taskId: task.id })}
              disabled={!canStop}
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
            <ul className="event-list output-panel">
              {compactEvents.map((event) => (
                <li key={event.id} className={["failed", "completed", "result_approval_requested", "result_approval_granted", "user_input_requested"].includes(event.type) ? "event-item-important" : ""}>
                  <strong>{event.message}</strong>
                  <span>{new Date(event.created_at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
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
          {mobileScreen === "projects" ? (
            <section className="panel mobile-screen">
              <div className="panel-header">
                <div className="row-header">
                  <div>
                    <h2>Projects</h2>
                    <p>Tap a project to open tasks</p>
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
                      {deleteProjectMutation.isPending ? "Deleting..." : "Delete Project"}
                    </button>
                  </div>
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
                        setMobileScreen("tasks");
                      }}
                      title={project.repo_path}
                    >
                      <strong>{project.name}</strong>
                      <span className="item-secondary truncate">{project.repo_path}</span>
                    </button>
                  ))
                ) : (
                  <p className="empty-state">No projects yet. Use + to create one.</p>
                )}
              </div>
            </section>
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
                <button type="button" onClick={() => setTaskModalOpen(true)} disabled={!selectedProject}>
                  + New Task
                </button>
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
            {renderTaskDetailContent(false)}
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
          isMobile={isMobile}
          onCreate={(payload) => createTaskMutation.mutate(payload)}
          onClose={() => setTaskModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
