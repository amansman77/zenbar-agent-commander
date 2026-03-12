import type {
  ApproveTaskRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  ProjectSummary,
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
  createProject: (payload: CreateProjectRequest) =>
    request<ProjectSummary>("/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listTasks: (projectId: string) =>
    request<TaskSummary[]>(`/projects/${projectId}/tasks`),
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
