import { type ReactNode, useEffect, useMemo, useState } from "react";
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
  waiting_user_input: "amber",
  waiting_result_approval: "amber",
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
      source.close();
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

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status status-${statusTone[status]}`}>{status}</span>;
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
  onCreate,
  onClose
}: {
  project: ProjectSummary | null;
  models: RuntimeModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  onCreate: (payload: CreateTaskRequest) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("Fix sitemap canonical");
  const [prompt, setPrompt] = useState("Analyze the repository and fix canonical tag generation.");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [model, setModel] = useState("");

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

  const canSubmit = Boolean(project && model && models.length > 0 && !modelsLoading);

  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
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
      }}
    >
      <div className="panel-header">
        <h2>Task Workspace</h2>
        <p>Create an isolated task workspace for the selected project.</p>
      </div>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!project} />
      </label>
      <label>
        Prompt
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={!project} />
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
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
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
  const [fabOpen, setFabOpen] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [planCopyState, setPlanCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [promptCopyState, setPromptCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [retryModel, setRetryModel] = useState("");
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

  const task = taskDetailQuery.data ?? null;
  const events = taskEventsQuery.data ?? [];
  const diff = taskDiffQuery.data ?? task?.latest_diff;
  const retryModelOptions = useMemo(() => {
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
      setRetryModel("");
      return;
    }
    if (task.model && retryModelOptions.includes(task.model)) {
      setRetryModel(task.model);
      return;
    }
    setRetryModel(retryModelOptions[0] ?? "");
  }, [task, retryModelOptions]);

  useEffect(() => {
    if (!isMobile) {
      setMobileScreen("projects");
      setFabOpen(false);
    }
  }, [isMobile]);

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

  const renderTaskDetailContent = (mobile: boolean) => {
    if (!task) {
      return <p className="empty-state">Select a task to inspect the Task Workspace and approval state.</p>;
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
            <span className="meta-label">Requested model</span>
            <strong className="break-value mono">{task.model ?? "Unknown"}</strong>
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
            Retry model
            <select
              aria-label="Retry model"
              value={retryModel}
              onChange={(event) => setRetryModel(event.target.value)}
              disabled={retryModelOptions.length === 0}
            >
              {retryModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => taskActionMutation.mutate({ action: "approveTask", taskId: task.id })}
            disabled={task.status !== "waiting_result_approval"}
          >
            Approve
          </button>
          <button
            className="secondary"
            onClick={() => taskActionMutation.mutate({ action: "stopTask", taskId: task.id })}
            disabled={["completed", "failed", "stopped"].includes(task.status)}
          >
            Stop
          </button>
          <button
            className="secondary"
            onClick={() => taskActionMutation.mutate({ action: "retryTask", taskId: task.id, model: retryModel || undefined })}
            disabled={!["failed", "stopped", "completed"].includes(task.status) || !retryModel}
          >
            Retry
          </button>
        </div>

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
            {mobile ? (
              <ul className="event-accordion output-panel">
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      type="button"
                      className="event-toggle"
                      onClick={() =>
                        setExpandedEvents((previous) => ({ ...previous, [event.id]: !previous[event.id] }))
                      }
                    >
                      <span>{expandedEvents[event.id] ? "▼" : "▶"} {event.message}</span>
                    </button>
                    {expandedEvents[event.id] ? (
                      <div className="event-detail">
                        <span className="mono">{event.type}</span>
                        <span>{new Date(event.created_at).toLocaleString()}</span>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="event-list output-panel">
                {events.map((event) => (
                  <li key={event.id}>
                    <span>{event.type}</span>
                    <strong>{event.message}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Diff summary</h3>
            <div className="output-panel">
              <p>{diff?.summary && diff.summary.trim().length > 0 ? diff.summary : "Waiting for runtime diff."}</p>
              <ul>
                {diff?.files_changed.map((file: string) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              {diff?.raw_diff ? <pre className="output-pre">{diff.raw_diff}</pre> : null}
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
                <h2>Projects</h2>
                <p>Tap a project to open tasks</p>
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
                      <span className="truncate">{project.repo_path}</span>
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
                          <span>{item.execution_mode}</span>
                          <span className="mono truncate">{item.workspace_ref}</span>
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
            <section className="panel mobile-screen detail-panel">
              <div className="panel-header mobile-title-row">
                <button type="button" className="secondary mobile-back" onClick={() => setMobileScreen("tasks")}>
                  Back
                </button>
                <div>
                  <h2>Task Detail</h2>
                  <p>{task?.title ?? "Select task"}</p>
                </div>
                {task ? <StatusBadge status={task.status} /> : null}
              </div>
              {renderTaskDetailContent(true)}
            </section>
          ) : null}
        </main>
      ) : (
        <main className="workspace-grid">
          <section className="panel sidebar">
            <div className="panel-header">
              <h2>Projects</h2>
              <p>Connected repositories</p>
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
                    <span className="truncate">{project.repo_path}</span>
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
                        <span>{item.execution_mode}</span>
                        <span className="mono truncate">{item.workspace_ref}</span>
                      </div>
                      <span className="mono truncate">{item.workspace_path ?? "workspace pending"}</span>
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

      {isMobile ? (
        <div className="fab-wrap">
          {fabOpen ? (
            <div className="fab-menu">
              <button
                type="button"
                onClick={() => {
                  setProjectModalOpen(true);
                  setFabOpen(false);
                }}
              >
                New Project
              </button>
              <button
                type="button"
                onClick={() => {
                  setTaskModalOpen(true);
                  setFabOpen(false);
                }}
                disabled={!selectedProject}
              >
                New Task
              </button>
            </div>
          ) : null}
          <button type="button" className="fab-button" onClick={() => setFabOpen((value) => !value)}>
            +
          </button>
        </div>
      ) : null}

      <Modal title="New Project" open={projectModalOpen} onClose={() => setProjectModalOpen(false)}>
        <ProjectForm onCreate={(payload) => createProjectMutation.mutate(payload)} onClose={() => setProjectModalOpen(false)} />
      </Modal>

      <Modal title="New Task" open={taskModalOpen} onClose={() => setTaskModalOpen(false)}>
        <TaskForm
          project={selectedProject}
          models={runtimeModelsQuery.data?.models ?? []}
          modelsLoading={runtimeModelsQuery.isLoading}
          modelsError={runtimeModelsQuery.error instanceof Error ? runtimeModelsQuery.error.message : null}
          onCreate={(payload) => createTaskMutation.mutate(payload)}
          onClose={() => setTaskModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
