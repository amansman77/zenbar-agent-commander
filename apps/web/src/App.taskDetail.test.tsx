// App integration tests covering the task detail panel: run actions, pending questions, plan output and
// the event timeline.
//
// The fetch mock, fixture data and shared setup live in test/appHarness.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { fetchMock, fixtures, renderApp, resetAppTest } from "./test/appHarness";

describe("App", () => {
  beforeEach(resetAppTest);

  it("scopes the desktop Retry model dropdown to the selected task's own engine", async () => {
    // Regression: this query used to omit the `engine` param entirely, so
    // the backend's default (Codex) model list was fetched regardless of
    // which engine the task actually ran on -- an Antigravity or Grok
    // task's "Retry model" dropdown silently offered Codex model ids.
    // Reproduced live against the real app before this fix.
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.taskDetail = {
      id: "task-1",
      project_id: "project-1",
      title: "Explain the repo",
      prompt: "Explain the repo",
      execution_mode: "execute",
      engine: "antigravity",
      model: "gemini-3.7-flash-high",
      effective_model: "gemini-3.7-flash-high",
      reasoning_effort: "medium",
      status: "completed",
      workspace_type: "worktree",
      workspace_ref: "agent-commander/task-abcd",
      workspace_path: "/tmp/workspace",
      runtime_session_id: "mock-task-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      project: fixtures.projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    // Seed initial selection directly (App reads this once on mount) rather
    // than driving the click-through, since the point of this test is the
    // query the selection triggers, not the navigation itself.
    window.localStorage.setItem(
      "zenbar:lastView",
      JSON.stringify({
        mobileScreen: "conversations",
        desktopView: "workspace",
        selectedConversationId: null,
        selectedProjectId: "project-1",
        selectedTaskId: "task-1"
      })
    );

    renderApp();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/runtime/models?engine=antigravity"))
      ).toBe(true);
    });

    // And the dropdown itself ends up populated with Antigravity's models,
    // not Codex's.
    await waitFor(() => {
      expect(screen.getByLabelText("Retry model")).toHaveTextContent("gemini-3.7-flash-high");
    });
    expect(screen.getByLabelText("Retry model")).not.toHaveTextContent("GPT-5.4");
  });

  it("renders user input form and submits structured response", async () => {
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
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
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
      prompt: "Ask a question",
      project: fixtures.projects[0],
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

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /need input/i }));

    expect(await screen.findByText("User input required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
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
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
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
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
      prompt: "Review result",
      project: fixtures.projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: "result_approval",
      pending_request_id: "req-approve",
      pending_request_payload_json: { method: "item/fileChange/requestApproval" },
      pending_questions: []
    };

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /review result/i }));

    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send response" })).not.toBeInTheDocument();
  });

  it("renders latest plan output in a dedicated panel", async () => {
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
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
    fixtures.taskEvents = [
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
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
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

    renderApp();

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
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
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
    fixtures.taskEvents = [
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
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
      prompt: "Create plan",
      project: fixtures.projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plan from delta/i }));

    expect(await screen.findByText("Plan output")).toBeInTheDocument();
    expect(screen.getByText("Inspect repository. Add regression tests.")).toBeInTheDocument();
  });

  it("retries task with selected model override", async () => {
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
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
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
      prompt: "Retry with model override",
      model: "GPT-5.4",
      project: fixtures.projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    renderApp();

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

  it("hides technical events by default and loads them only when the user asks", async () => {
    // Regression/feature test: command_executed and agent_status events
    // used to always be fetched in full (98% of a long task's payload,
    // measured live), even though the timeline keeps them collapsed by
    // default -- now the default fetch excludes them, and a "load full
    // timeline" button pulls them in only when tapped.
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.tasks = [
      {
        id: "task-1",
        project_id: "project-1",
        title: "Run migration",
        status: "completed",
        execution_mode: "execute",
        workspace_type: "branch",
        workspace_ref: "task/run-migration-a1b2",
        workspace_path: "/tmp/workspace",
        runtime_session_id: "mock-task-1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
    fixtures.taskEvents = [
      {
        id: "event-1",
        task_id: "task-1",
        seq: 1,
        type: "command_executed",
        message: "pnpm test",
        payload_json: null,
        created_at: new Date().toISOString()
      },
      {
        id: "event-2",
        task_id: "task-1",
        seq: 2,
        type: "completed",
        message: "Task completed",
        payload_json: null,
        created_at: new Date().toISOString()
      }
    ];
    fixtures.taskDetail = {
      ...fixtures.tasks[0],
      prompt: "Run the migration",
      project: fixtures.projects[0],
      approvals: [],
      latest_diff: { files_changed: [], summary: "", raw_diff: null },
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: /run migration/i }));

    const loadFullButton = await screen.findByRole("button", { name: "실행 로그 1건 더 보기" });
    // The technical event is excluded by default -- its execution summary
    // ("ran N commands") must not appear until the button is tapped.
    expect(screen.queryByText(/ran \d+ commands/)).not.toBeInTheDocument();

    fireEvent.click(loadFullButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/tasks\/task-1\/events$/), expect.anything());
    });
    expect(await screen.findByText(/ran \d+ commands/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실행 로그 1건 더 보기" })).not.toBeInTheDocument();
  });
});
