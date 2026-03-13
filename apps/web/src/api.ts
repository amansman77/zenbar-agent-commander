import type {
  ApproveTaskRequest,
  CreateProjectRequest,
  DiscoverProjectRequest,
  DiscoverProjectResponse,
  ListRuntimeModelsResponse,
  CreateTaskRequest,
  ProjectSummary,
  RespondTaskRequest,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskSummary
} from "@zenbar/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
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
  streamUrl: (taskId: string) => `${API_BASE}/tasks/${taskId}/stream`
};
