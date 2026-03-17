import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

let projects: Array<Record<string, unknown>> = [];
let tasks: Array<Record<string, unknown>> = [];
let taskDetail: Record<string, unknown> | null = null;
let taskEvents: Array<Record<string, unknown>> = [];
let taskDiff: Record<string, unknown> = { files_changed: [], summary: "", raw_diff: null };

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.endsWith("/runtime/models")) {
    return new Response(
      JSON.stringify({
        source: "runtime",
        models: [{ id: "GPT-5.4" }, { id: "GPT-5.3-Codex" }]
      }),
      { status: 200 }
    );
  }
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
  if (url.endsWith("/projects/project-1/tasks")) {
    return new Response(JSON.stringify(tasks), { status: 200 });
  }
  if (url.endsWith("/tasks") && init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    const createdTask = {
      id: "task-1",
      project_id: payload.project_id,
      title: payload.title,
      prompt: payload.prompt,
      execution_mode: payload.execution_mode ?? "execute",
      model: payload.model ?? "GPT-5.4",
      reasoning_effort: payload.reasoning_effort ?? "medium",
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
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };
    taskDetail = createdTask;
    tasks = [createdTask];
    return new Response(JSON.stringify(createdTask), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/respond") && init?.method === "POST") {
    taskDetail = {
      ...(taskDetail ?? {}),
      status: "running",
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };
    return new Response(JSON.stringify(taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/approve") && init?.method === "POST") {
    taskDetail = { ...(taskDetail ?? {}), status: "running" };
    return new Response(JSON.stringify(taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/retry") && init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    taskDetail = { ...(taskDetail ?? {}), status: "starting", model: payload.model ?? (taskDetail as Record<string, unknown> | null)?.model };
    return new Response(JSON.stringify(taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1")) {
    return new Response(JSON.stringify(taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/events")) {
    return new Response(JSON.stringify(taskEvents), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/diff")) {
    return new Response(JSON.stringify(taskDiff), { status: 200 });
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
    tasks = [];
    taskDetail = null;
    taskEvents = [];
    taskDiff = { files_changed: [], summary: "", raw_diff: null };
    window.localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders Web Commander shell", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Web Commander")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Task Detail")).toBeInTheDocument();
  });

  it("autofills project fields from repository discovery and keeps them editable", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose folder" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("agent-commander")).toBeInTheDocument();
    });

    const repoPath = screen.getByDisplayValue("/Users/hosung/Workspace/zenbar/agent-commander");
    fireEvent.change(repoPath, { target: { value: "/tmp/custom" } });

    expect(screen.getByDisplayValue("/tmp/custom")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/projects\/discover$/),
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
    fireEvent.click(await screen.findByRole("button", { name: "New Task" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Execution mode")).toBeEnabled();
      expect(screen.getByLabelText("Model")).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText("Execution mode"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "GPT-5.4" } });
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
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      execution_mode: "plan",
      model: "GPT-5.4",
      reasoning_effort: "high"
    });
  });

  it("preloads runtime models and requires explicit model selection before task creation", async () => {
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

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runtime/models"))).toBe(true);
    });

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: "New Task" }));

    const createButton = await screen.findByRole("button", { name: "Create task" });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "GPT-5.4" } });
    expect(createButton).toBeEnabled();
  });

  it("submits task through mobile 3-step creation flow", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

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
    fireEvent.click((await screen.findAllByRole("button", { name: "New Task" }))[0]);

    const nextButtonStep1 = await screen.findByRole("button", { name: "Next" });
    expect(nextButtonStep1).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Mobile flow task" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Create a mobile-first plan and execute it safely." } });
    expect(nextButtonStep1).toBeEnabled();
    fireEvent.click(nextButtonStep1);

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(await screen.findByRole("button", { name: "GPT-5.4" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("button", { name: "Show full prompt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    let taskCall:
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    await waitFor(() => {
      taskCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/tasks") && (init as RequestInit | undefined)?.method === "POST"
      ) as [RequestInfo | URL, RequestInit | undefined] | undefined;
      expect(taskCall).toBeTruthy();
    });
    const [, init] = taskCall!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      title: "Mobile flow task",
      prompt: "Create a mobile-first plan and execute it safely.",
      execution_mode: "plan",
      reasoning_effort: "high",
      model: "GPT-5.4"
    });
  });

  it("renders user input form and submits structured response", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Need input",
        status: "waiting_user_input",
        execution_mode: "execute",
        workspace_type: "branch",
        workspace_ref: "task/need-input-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Ask a question",
      project: projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: "user_input",
      pending_request_id: "req-1",
      pending_request_payload_json: { questions: [{ id: "q1" }] },
      pending_questions: [
        {
          id: "q1",
          header: "Branch",
          question: "Which branch should be used?",
          is_other: false,
          is_secret: false,
          options: [{ label: "main", description: "Default branch" }]
        }
      ]
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /need input/i }));

    expect(await screen.findByText("User input required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/tasks\/task-1\/respond$/),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("shows approve action only for waiting result approval state", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Review result",
        status: "waiting_result_approval",
        execution_mode: "execute",
        workspace_type: "branch",
        workspace_ref: "task/review-result-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Review result",
      project: projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: "result_approval",
      pending_request_id: "req-approve",
      pending_request_payload_json: { method: "item/fileChange/requestApproval" },
      pending_questions: []
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /review result/i }));

    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send response" })).not.toBeInTheDocument();
  });

  it("renders latest plan output in a dedicated panel", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Plan canonical",
        status: "completed",
        execution_mode: "plan",
        workspace_type: "branch",
        workspace_ref: "task/plan-canonical-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskEvents = [
      {
        id: "event-1",
        task_id: "task-1",
        seq: 1,
        type: "plan_updated",
        message: "Plan updated with 2 step(s)",
        payload_json: {
          explanation: "Produce a safe implementation sequence.",
          plan: [
            { step: "Inspect sitemap generation", status: "completed" },
            { step: "Add regression test coverage", status: "pending" }
          ]
        },
        created_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Create plan",
      project: {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      },
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plan canonical/i }));

    expect(await screen.findByText("Input prompt")).toBeInTheDocument();
    expect(screen.getByText("Create plan")).toBeInTheDocument();
    expect(await screen.findByText("Plan output")).toBeInTheDocument();
    expect(screen.getByText("Produce a safe implementation sequence.")).toBeInTheDocument();
    expect(screen.getByText("Inspect sitemap generation")).toBeInTheDocument();
    expect(screen.getByText("Add regression test coverage")).toBeInTheDocument();

    const writeText = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    writeText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Create plan");
    });

    writeText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
  });

  it("renders plan output from plan delta chunks when plan steps are unavailable", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Plan from delta",
        status: "completed",
        execution_mode: "plan",
        workspace_type: "branch",
        workspace_ref: "task/plan-delta-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskEvents = [
      {
        id: "event-1",
        task_id: "task-1",
        seq: 1,
        type: "plan_delta",
        message: "Inspect",
        payload_json: { delta: "Inspect repository. " },
        created_at: new Date().toISOString()
      },
      {
        id: "event-2",
        task_id: "task-1",
        seq: 2,
        type: "plan_delta",
        message: "Tests",
        payload_json: { delta: "Add regression tests." },
        created_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Create plan",
      project: projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plan from delta/i }));

    expect(await screen.findByText("Plan output")).toBeInTheDocument();
    expect(screen.getByText("Inspect repository. Add regression tests.")).toBeInTheDocument();
  });

  it("uses mobile navigation flow under 768px", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Mobile task",
        status: "completed",
        execution_mode: "plan",
        workspace_type: "branch",
        workspace_ref: "task/mobile-task-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Create plan",
      project: projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };
    taskEvents = [
      {
        id: "event-mobile",
        task_id: "task-1",
        seq: 1,
        type: "plan_delta",
        message: "delta",
        payload_json: { delta: "Mobile plan output." },
        created_at: new Date().toISOString()
      }
    ];

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Projects")).toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole("button", { name: "New Project" }))[1]);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "agent-commander" } });
    fireEvent.change(screen.getByLabelText("Repository path"), { target: { value: "/Users/hosung/Workspace/zenbar/agent-commander" } });
    fireEvent.change(screen.getByLabelText("Default branch"), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    expect(await screen.findByText("Tasks")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /mobile task/i }));
    expect(await screen.findByText("Input prompt")).toBeInTheDocument();
    expect(await screen.findByText("Log")).toBeInTheDocument();
  });

  it("retries task with selected model override", async () => {
    projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Retry with model",
        status: "failed",
        execution_mode: "execute",
        workspace_type: "branch",
        workspace_ref: "task/retry-model-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    taskDetail = {
      ...tasks[0],
      prompt: "Retry with model override",
      model: "GPT-5.4",
      project: projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /retry with model/i }));
    fireEvent.change(await screen.findByLabelText("Retry model"), { target: { value: "GPT-5.3-Codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/tasks\/task-1\/retry$/),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ actor: "web-commander", model: "GPT-5.3-Codex" })
        })
      );
    });
  });
});
