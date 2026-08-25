// App integration tests covering the shell: which surface the app opens on, desktop vs mobile
// navigation, and the conversation list.
//
// The fetch mock, fixture data and shared setup live in test/appHarness.

import { fireEvent, screen } from "@testing-library/react";
import { fixtures, renderApp, resetAppTest } from "./test/appHarness";

describe("App", () => {
  beforeEach(resetAppTest);

  it("shows the conversation view by default on desktop", async () => {
    // Desktop parity with mobile: conversations are the landing surface, and
    // the chat components rendered here are the same ones the mobile shell
    // uses (so pipelines/skills/prompt pickers exist on both by construction).
    window.localStorage.clear();

    renderApp();

    expect(await screen.findByText("Conversations")).toBeInTheDocument();
    // The project workspace is reachable, but not what desktop opens on.
    expect(screen.queryByText("Task Detail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "프로젝트" }));
    expect(await screen.findByText("Task Detail")).toBeInTheDocument();
  });

  it("renders Web Commander shell", async () => {
    renderApp();

    expect(await screen.findByText("Web Commander")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Task Detail")).toBeInTheDocument();
  });

  it("uses mobile navigation flow under 768px", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    fixtures.tasks = [
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
    fixtures.taskEvents = [
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

    renderApp();

    // Mobile opens on Conversations; step into the Projects screen first.
    fireEvent.click(await screen.findByRole("button", { name: "Projects" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "새 프로젝트" }))[1]);
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

  it("shows only the preview-count conversations per project until 더보기 is tapped", async () => {
    // Regression/feature test: the conversations list is polled repeatedly
    // while the dashboard is open, but a project with many conversations
    // only shows the first few by default -- the rest used to be fetched
    // and thrown away on every single poll. Now the default fetch itself
    // is capped server-side (preview_count), with the true total (for the
    // "더보기 (N)" label) coming from a separate, much smaller endpoint,
    // and the full list only fetched once the user actually asks for it.
    window.localStorage.setItem(
      "zenbar:lastView",
      JSON.stringify({
        mobileScreen: "conversations",
        desktopView: "chat",
        selectedConversationId: null,
        selectedProjectId: null,
        selectedTaskId: null
      })
    );
    const allFive = Array.from({ length: 5 }, (_, i) => ({
      id: `conv-${i}`,
      title: `Conversation ${i}`,
      last_message: null,
      project_id: "project-1",
      project_name: "agent-commander",
      task_id: null,
      task_status: null,
      updated_at: new Date(2026, 0, 1, 0, i).toISOString()
    })).reverse(); // most-recently-updated first, matching the real endpoint's ordering
    fixtures.conversations = allFive;
    fixtures.conversationCounts = { "project-1": 5 };

    renderApp();

    expect(await screen.findByText("Conversation 4")).toBeInTheDocument();
    expect(screen.getByText("Conversation 3")).toBeInTheDocument();
    expect(screen.getByText("Conversation 2")).toBeInTheDocument();
    // Preview caps at 3 -- the older two aren't rendered (and, before the
    // 더보기 tap, were never actually fetched either).
    expect(screen.queryByText("Conversation 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Conversation 0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "더보기 (2)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더보기 (2)" }));

    expect(await screen.findByText("Conversation 1")).toBeInTheDocument();
    expect(screen.getByText("Conversation 0")).toBeInTheDocument();
  });
});
