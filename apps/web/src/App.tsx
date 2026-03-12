import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProjectRequest,
  CreateTaskRequest,
  DiscoverProjectResponse,
  ExecutionMode,
  ProjectSummary,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskStatus
} from "@zenbar/shared";
import { api } from "./api";

const actor = "web-commander";

const statusTone: Record<TaskStatus, string> = {
  queued: "slate",
  starting: "blue",
  running: "blue",
  waiting_approval: "amber",
  approved: "green",
  stopped: "slate",
  failed: "red",
  completed: "green"
};

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

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status status-${statusTone[status]}`}>{status}</span>;
}

function ProjectForm({ onCreate }: { onCreate: (payload: CreateProjectRequest) => void }) {
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
      <p>
        Form state: {lastDiscovered ? "discovered" : "manual"} / name {fieldOrigin.name} / path {fieldOrigin.repoPath}
        / branch {fieldOrigin.defaultBranch}
      </p>
    </form>
  );
}

function TaskForm({
  project,
  onCreate
}: {
  project: ProjectSummary | null;
  onCreate: (payload: CreateTaskRequest) => void;
}) {
  const [title, setTitle] = useState("Fix sitemap canonical");
  const [prompt, setPrompt] = useState("Analyze the repository and fix canonical tag generation.");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");

  return (
    <form
      className="panel form-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!project) {
          return;
        }
        onCreate({ project_id: project.id, title, prompt, execution_mode: executionMode, workspace_type: "branch" });
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
      {executionMode === "plan" ? (
        <p>Plan mode checks Codex runtime collaboration capability and streams planning steps into the event log.</p>
      ) : null}
      <button type="submit" disabled={!project}>
        Create task
      </button>
    </form>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects
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
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: api.createTask,
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      setSelectedTaskId(task.id);
    }
  });

  const taskActionMutation = useMutation({
    mutationFn: async (input: { action: "approveTask" | "stopTask" | "retryTask"; taskId: string }) => {
      if (input.action === "approveTask") {
        return api.approveTask(input.taskId, { actor });
      }
      if (input.action === "stopTask") {
        return api.stopTask(input.taskId, { actor });
      }
      return api.retryTask(input.taskId, { actor });
    },
    onSuccess: (task) => {
      queryClient.setQueryData(["task", task.id], task);
      queryClient.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      queryClient.invalidateQueries({ queryKey: ["task-events", task.id] });
      queryClient.invalidateQueries({ queryKey: ["task-diff", task.id] });
    }
  });

  const task = taskDetailQuery.data ?? null;
  const events = taskEventsQuery.data ?? [];
  const diff = taskDiffQuery.data ?? task?.latest_diff;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Zenbar Agent Commander</p>
          <h1>Control plane for Codex App Server runtime</h1>
          <p className="hero-copy">
            Monitor tasks, review isolated Task Workspace output, and accept results only after human approval.
          </p>
        </div>
      </header>

      <main className="workspace-grid">
        <aside className="sidebar">
          <ProjectForm onCreate={(payload) => createProjectMutation.mutate(payload)} />
          <section className="panel list-panel">
            <div className="panel-header">
              <h2>Projects</h2>
            </div>
            {projectsQuery.data?.map((project) => (
              <button
                key={project.id}
                className={project.id === selectedProjectId ? "list-item active" : "list-item"}
                onClick={() => {
                  setSelectedProjectId(project.id);
                  setSelectedTaskId(null);
                }}
              >
                <strong>{project.name}</strong>
                <span>{project.repo_path}</span>
              </button>
            ))}
          </section>
        </aside>

        <section className="content-grid">
          <TaskForm project={selectedProject} onCreate={(payload) => createTaskMutation.mutate(payload)} />
          <section className="panel list-panel">
            <div className="panel-header">
              <h2>Tasks</h2>
            </div>
            {tasksQuery.data?.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedTaskId ? "list-item active" : "list-item"}
                onClick={() => setSelectedTaskId(item.id)}
              >
                <div className="list-row">
                  <strong>{item.title}</strong>
                  <StatusBadge status={item.status} />
                </div>
                <span>{item.execution_mode}</span>
                <span>{item.workspace_ref}</span>
                <span>{item.workspace_path}</span>
              </button>
            ))}
          </section>
          <section className="panel detail-panel">
            <div className="panel-header">
              <div>
                <h2>Task Detail</h2>
                <p>Orchestration API view into the active Codex App Server session.</p>
              </div>
              {task ? <StatusBadge status={task.status} /> : null}
            </div>

            {task ? (
              <>
                <div className="meta-grid">
                  <div>
                    <span className="meta-label">Project</span>
                    <strong>{task.project.name}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Execution mode</span>
                    <strong>{task.execution_mode}</strong>
                  </div>
                  <div>
                    <span className="meta-label">Task Workspace</span>
                    <strong>{task.workspace_ref}</strong>
                    <span>{task.workspace_path}</span>
                  </div>
                  <div>
                    <span className="meta-label">Runtime session</span>
                    <strong>{task.runtime_session_id ?? "Not started"}</strong>
                  </div>
                </div>

                <div className="action-row">
                  <button
                    onClick={() => taskActionMutation.mutate({ action: "approveTask", taskId: task.id })}
                    disabled={task.execution_mode === "plan" || !["waiting_approval", "running"].includes(task.status)}
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
                    onClick={() => taskActionMutation.mutate({ action: "retryTask", taskId: task.id })}
                    disabled={!["failed", "stopped", "completed"].includes(task.status)}
                  >
                    Retry
                  </button>
                </div>

                <div className="detail-grid">
                  <section>
                    <h3>Event log</h3>
                    <ul className="event-list">
                      {events.map((event) => (
                        <li key={event.id}>
                          <span>{event.type}</span>
                          <strong>{event.message}</strong>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3>Diff summary</h3>
                    <div className="diff-panel">
                      <p>{diff?.summary ?? "Waiting for runtime diff."}</p>
                      <ul>
                        {diff?.files_changed.map((file: string) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                      {diff?.raw_diff ? <pre>{diff.raw_diff}</pre> : null}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <p className="empty-state">Select a task to inspect the Task Workspace and approval state.</p>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}
