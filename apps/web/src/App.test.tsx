import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

let projects: Array<Record<string, unknown>> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.endsWith("/projects/discover")) {
    return new Response(
      JSON.stringify({
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        current_branch: "main",
        is_git_repo: true
      }),
      { status: 200 }
    );
  }
  if (url.endsWith("/projects") && init?.method === "POST") {
    const project = {
      id: "project-1",
      name: "agent-commander",
      repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
      default_branch: "main",
      created_at: new Date().toISOString()
    };
    projects = [project];
    return new Response(JSON.stringify(project), { status: 200 });
  }
  if (url.endsWith("/projects")) {
    return new Response(JSON.stringify(projects), { status: 200 });
  }
  if (url.endsWith("/tasks") && init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        id: "task-1",
        project_id: payload.project_id,
        title: payload.title,
        prompt: payload.prompt,
        execution_mode: payload.execution_mode ?? "execute",
        status: "running",
        workspace_type: payload.workspace_type ?? "branch",
        workspace_ref: "task/fix-canonical-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        project: {
          id: payload.project_id,
          name: "agent-commander",
          repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
          default_branch: "main",
          created_at: new Date().toISOString()
        },
        approvals: [],
        latest_diff: { files_changed: [], summary: "", raw_diff: null }
      }),
      { status: 200 }
    );
  }
  return new Response(JSON.stringify([]), { status: 200 });
});

vi.stubGlobal("fetch", fetchMock);

vi.stubGlobal(
  "EventSource",
  class {
    close() {}
  }
);

describe("App", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    projects = [];
  });

  it("renders Web Commander shell", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Web Commander")).toBeInTheDocument();
    expect(screen.getByText("Task Workspace")).toBeInTheDocument();
  });

  it("autofills project fields from repository discovery and keeps them editable", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("agent-commander")).toBeInTheDocument();
    });

    const repoPath = screen.getByDisplayValue("/Users/hosung/Workspace/zenbar/agent-commander");
    fireEvent.change(repoPath, { target: { value: "/tmp/custom" } });

    expect(screen.getByDisplayValue("/tmp/custom")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/projects/discover",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("submits plan mode task creation payload", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    await waitFor(() => {
      expect(screen.getByLabelText("Execution mode")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText("Execution mode"), { target: { value: "plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    let taskCall:
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    await waitFor(() => {
      taskCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/tasks") && (init as RequestInit | undefined)?.method === "POST"
      ) as [RequestInfo | URL, RequestInit | undefined] | undefined;
      expect(taskCall).toBeTruthy();
    });
    expect(taskCall).toBeTruthy();
    const [, init] = taskCall!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ execution_mode: "plan" });
  });
});
