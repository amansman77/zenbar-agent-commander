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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  listConversations: () => request<ConversationSummary[]>("/conversations"),
  createConversation: (payload: CreateConversationRequest = {}) =>
    request<ConversationDetail>("/conversations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getConversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  getConversationPrInfo: (id: string) => request<PrInfo | null>(`/conversations/${id}/pr-info`),
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
  }
};
