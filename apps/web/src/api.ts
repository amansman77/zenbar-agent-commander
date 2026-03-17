import type {
  ApproveTaskRequest,
  CommitTaskRequest,
  CreateProjectRequest,
  DiscoverProjectRequest,
  DiscoverProjectResponse,
  ListRuntimeModelsResponse,
  CreateTaskRequest,
  ProjectSummary,
  PushTaskRequest,
  RespondTaskRequest,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskGitActionResult,
  TaskSummary
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
  listTasks: (projectId: string) =>
    request<TaskSummary[]>(`/projects/${projectId}/tasks`),
  listRuntimeModels: () => request<ListRuntimeModelsResponse>("/runtime/models"),
  createTask: (payload: CreateTaskRequest) =>
    request<TaskDetail>("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getTask: (taskId: string) => request<TaskDetail>(`/tasks/${taskId}`),
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
