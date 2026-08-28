import type {
  AddConversationMessageRequest,
  ApproveTaskRequest,
  CommitTaskRequest,
  ConversationDetail,
  ConversationSummary,
  CreateConversationRequest,
  CreateProjectPipelineRequest,
  CreateProjectPromptRequest,
  CreateProjectRequest,
  DiscoverProjectRequest,
  DiscoverProjectResponse,
  FsBrowseResponse,
  FollowupTurnRequest,
  ListRuntimeEnginesResponse,
  ListRuntimeModelsResponse,
  ListRuntimeProfilesResponse,
  ListRuntimeSkillsResponse,
  RuntimeUsageResponse,
  PrInfo,
  CreateTaskRequest,
  ProjectPipeline,
  ProjectPrompt,
  ProjectSummary,
  PushTaskRequest,
  ReorderProjectPromptsRequest,
  RespondTaskRequest,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskGitActionResult,
  TaskSummary,
  UpdateProjectPipelineRequest,
  UpdateProjectPromptRequest
} from "@zenbar/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const API_TOKEN = (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim();

function authHeaders(): Record<string, string> {
  if (!API_TOKEN) {
    return {};
  }
  return { "X-Zenbar-Token": API_TOKEN };
}

async function requestWithHeaders<T>(path: string, init?: RequestInit): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return { data: undefined as T, headers: response.headers };
  }

  return { data: (await response.json()) as T, headers: response.headers };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await requestWithHeaders<T>(path, init);
  return data;
}

// Kept in sync with main.py's own notion of "technical" event types
// (command_executed, agent_status) -- these dominate a long task's event
// payload (98% of bytes, measured live) but are collapsed by default in
// the UI, so getEventsLean excludes them from the default fetch.
export const TECHNICAL_EVENT_TYPES = ["command_executed", "agent_status"];

export const api = {
  listConversations: (previewCount?: number) =>
    request<ConversationSummary[]>(
      previewCount != null ? `/conversations?preview_count=${previewCount}` : "/conversations"
    ),
  // Paired with listConversations(previewCount): that response omits
  // conversations past each project's preview cutoff, so the "더보기 (N)"
  // button needs the true per-project total from here to show its count
  // before the user has asked to see the rest.
  getConversationCounts: () => request<Record<string, number>>("/conversations/counts"),
  createConversation: (payload: CreateConversationRequest = {}) =>
    request<ConversationDetail>("/conversations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getConversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  markConversationRead: (id: string) =>
    request<void>(`/conversations/${id}/read`, { method: "POST" }),
  getConversationPrInfo: (id: string) => request<PrInfo[]>(`/conversations/${id}/pr-info`),
  // pr-info's own diff has raw_diff stripped (that list is polled every
  // 15s while a task is active; raw_diff is where nearly all of its
  // payload lives) -- this fetches one specific card's full diff, called
  // only once that card is actually expanded.
  getConversationPrDiff: (id: string, url: string) =>
    request<TaskDiff>(`/conversations/${id}/pr-diff?url=${encodeURIComponent(url)}`),
  deleteConversation: (id: string) =>
    request<void>(`/conversations/${id}`, { method: "DELETE" }),
  addConversationMessage: (id: string, payload: AddConversationMessageRequest) =>
    request<ConversationDetail>(`/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  browseFs: (path?: string) => {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    return request<FsBrowseResponse>(`/fs/browse${params}`);
  },
  listProjects: () => request<ProjectSummary[]>("/projects"),
  discoverProject: (payload: DiscoverProjectRequest = {}) =>
    request<DiscoverProjectResponse>("/projects/discover", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createProject: (payload: CreateProjectRequest) =>
    request<ProjectSummary>("/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteProject: (projectId: string) =>
    request<void>(`/projects/${projectId}`, {
      method: "DELETE"
    }),
  listProjectPrompts: (projectId: string) =>
    request<ProjectPrompt[]>(`/projects/${projectId}/prompts`),
  createProjectPrompt: (projectId: string, payload: CreateProjectPromptRequest) =>
    request<ProjectPrompt>(`/projects/${projectId}/prompts`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateProjectPrompt: (projectId: string, promptId: string, payload: UpdateProjectPromptRequest) =>
    request<ProjectPrompt>(`/projects/${projectId}/prompts/${promptId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteProjectPrompt: (projectId: string, promptId: string) =>
    request<void>(`/projects/${projectId}/prompts/${promptId}`, {
      method: "DELETE"
    }),
  reorderProjectPrompts: (projectId: string, payload: ReorderProjectPromptsRequest) =>
    request<ProjectPrompt[]>(`/projects/${projectId}/prompts/order`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  listProjectPipelines: (projectId: string) =>
    request<ProjectPipeline[]>(`/projects/${projectId}/pipelines`),
  createProjectPipeline: (projectId: string, payload: CreateProjectPipelineRequest) =>
    request<ProjectPipeline>(`/projects/${projectId}/pipelines`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateProjectPipeline: (projectId: string, pipelineId: string, payload: UpdateProjectPipelineRequest) =>
    request<ProjectPipeline>(`/projects/${projectId}/pipelines/${pipelineId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteProjectPipeline: (projectId: string, pipelineId: string) =>
    request<void>(`/projects/${projectId}/pipelines/${pipelineId}`, {
      method: "DELETE"
    }),
  listTasks: (projectId: string) =>
    request<TaskSummary[]>(`/projects/${projectId}/tasks`),
  listRuntimeEngines: () => request<ListRuntimeEnginesResponse>("/runtime/engines"),
  listRuntimeModels: (engine?: string | null) =>
    request<ListRuntimeModelsResponse>(`/runtime/models${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`),
  listRuntimeProfiles: () => request<ListRuntimeProfilesResponse>("/runtime/profiles"),
  listRuntimeSkills: () => request<ListRuntimeSkillsResponse>("/runtime/skills"),
  getRuntimeUsage: (engine: string) =>
    request<RuntimeUsageResponse>(`/runtime/usage?engine=${encodeURIComponent(engine)}`),
  createTask: (payload: CreateTaskRequest) =>
    request<TaskDetail>("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getTask: (taskId: string) => request<TaskDetail>(`/tasks/${taskId}`),
  deleteTask: (taskId: string) =>
    request<void>(`/tasks/${taskId}`, { method: "DELETE" }),
  getEvents: (taskId: string) => request<TaskEvent[]>(`/tasks/${taskId}/events`),
  getEventsLean: async (
    taskId: string
  ): Promise<{ events: TaskEvent[]; hiddenTechnicalCount: number; latestEventAt: string | null }> => {
    const { data, headers } = await requestWithHeaders<TaskEvent[]>(
      `/tasks/${taskId}/events?exclude_types=${TECHNICAL_EVENT_TYPES.join(",")}`
    );
    return {
      events: data,
      hiddenTechnicalCount: Number(headers.get("X-Excluded-Event-Count") ?? 0),
      // The excluded types are usually exactly what was most recently
      // happening, so "last event in this filtered list" would understate
      // how recently active the task really is -- the backend computes
      // this over the true full event history instead.
      latestEventAt: headers.get("X-Latest-Event-At")
    };
  },
  getDiff: (taskId: string) => request<TaskDiff>(`/tasks/${taskId}/diff`),
  approveTask: (taskId: string, payload: ApproveTaskRequest) =>
    request<TaskDetail>(`/tasks/${taskId}/approve`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  respondTask: (taskId: string, payload: RespondTaskRequest) =>
    request<TaskDetail>(`/tasks/${taskId}/respond`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createFollowupTurn: (sessionId: string, payload: FollowupTurnRequest) =>
    request<TaskDetail>(`/sessions/${sessionId}/turns`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  stopTask: (taskId: string, payload: ApproveTaskRequest) =>
    request<TaskDetail>(`/tasks/${taskId}/stop`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  retryTask: (taskId: string, payload: ApproveTaskRequest) =>
    request<TaskDetail>(`/tasks/${taskId}/retry`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  commitTaskWorkspace: (taskId: string, payload: CommitTaskRequest) =>
    request<TaskGitActionResult>(`/tasks/${taskId}/commit`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  pushTaskWorkspace: (taskId: string, payload: PushTaskRequest = {}) =>
    request<TaskGitActionResult>(`/tasks/${taskId}/push`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  streamUrl: (taskId: string) => {
    const url = new URL(`${API_BASE}/tasks/${taskId}/stream`);
    if (API_TOKEN) {
      url.searchParams.set("token", API_TOKEN);
    }
    return url.toString();
  },
  // <img src> can't send an Authorization header, so the token (same as
  // streamUrl above) rides along as a query param instead.
  workspaceFileUrl: (taskId: string, path: string) => {
    const url = new URL(`${API_BASE}/tasks/${taskId}/workspace-file`);
    url.searchParams.set("path", path);
    if (API_TOKEN) {
      url.searchParams.set("token", API_TOKEN);
    }
    return url.toString();
  }
};
