// App integration tests covering the shell: which surface the app opens on, desktop vs mobile
// navigation, and the conversation list.
//
// The fetch mock, fixture data and shared setup live in test/appHarness.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { fetchMock, fixtures, renderApp, resetAppTest } from "./test/appHarness";

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
      updated_at: new Date(2026, 0, 1, 0, i).toISOString(),
      is_unread: false
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
  describe("conversation model picker", () => {
    function openConversationWithoutTask(messages: Record<string, unknown>[] = []) {
      // jsdom has no scrollIntoView; the conversation screen calls it on mount.
      Element.prototype.scrollIntoView = vi.fn();
      window.localStorage.setItem(
        "zenbar:lastView",
        JSON.stringify({
          mobileScreen: "conversations",
          desktopView: "chat",
          selectedConversationId: "conv-1",
          selectedProjectId: null,
          selectedTaskId: null
        })
      );
      const now = new Date().toISOString();
      fixtures.conversationDetail = {
        id: "conv-1",
        title: "New conversation",
        project_id: "project-1",
        project_name: "agent-commander",
        task_id: null,
        task_status: null,
        task_workspace_ref: null,
        task_base_branch: null,
        task_model: null,
        task_profile: null,
        task_engine: null,
        messages,
        created_at: now,
        updated_at: now
      };
      renderApp();
    }

    it("offers the runtime's models when no profile is selected", async () => {
      openConversationWithoutTask();

      expect(await screen.findByRole("option", { name: "GPT-5.4" })).toBeInTheDocument();
      expect(screen.queryByText(/모델 목록을 불러오지 못함/)).not.toBeInTheDocument();
    });

    it("says the model list is unavailable instead of hiding the picker", async () => {
      // What the API returns when it cannot reach the engine: only the
      // "default" placeholder, which the picker filters out. The picker used
      // to disappear without a word (2026-09-30, App Server down after a
      // reboot), which looked like a Codex update had removed it.
      fixtures.runtimeModels = { source: "fallback", models: [{ id: "default" }] };
      openConversationWithoutTask();

      expect(await screen.findByText(/모델 목록을 불러오지 못함/)).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "default" })).not.toBeInTheDocument();
    });

    it("renders an assistant reply as markdown and keeps a screenshot inside its list", async () => {
      const now = new Date().toISOString();
      const reply = [
        "## 결과",
        "",
        "**완료**했습니다. `npm test` 통과.",
        "",
        "- [x] 마이그레이션",
        "- 스크린샷: ![결과](https://example.com/shot.png)",
        "- 로그는 [PR](https://github.com/o/r/pull/1) 참고",
        "",
        "| 항목 | 상태 |",
        "| --- | --- |",
        "| API | OK |",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "[악성](javascript:alert(1))"
      ].join("\n");
      openConversationWithoutTask([
        { id: "m1", conversation_id: "conv-1", role: "user", content: "**그대로** 보여야 함", created_at: now },
        { id: "m2", conversation_id: "conv-1", role: "assistant", content: reply, created_at: now }
      ]);

      expect(await screen.findByRole("heading", { name: "결과" })).toBeInTheDocument();
      expect(screen.getByText("완료").tagName).toBe("STRONG");
      expect(screen.getByText("npm test")).toHaveClass("inline-code");
      expect(screen.getByRole("checkbox")).toBeChecked();
      expect(screen.getByRole("cell", { name: "OK" })).toBeInTheDocument();
      expect(screen.getByText("const a = 1;").closest("pre")).toHaveClass("output-pre");
      // The screenshot becomes a thumbnail without splitting the list: all
      // three items stay in one <ul>.
      const shot = screen.getByRole("img", { name: "https://example.com/shot.png" });
      expect(shot.closest("ul")?.querySelectorAll(":scope > li")).toHaveLength(3);
      expect(screen.getByRole("link", { name: "PR" })).toHaveAttribute("target", "_blank");
      // react-markdown's URL sanitizer still applies to agent-written links.
      expect(screen.getByText("악성").closest("a")?.getAttribute("href") ?? "").not.toMatch(/javascript/i);
      // A user's own message is shown as typed, not rendered.
      expect(screen.getByText("**그대로** 보여야 함")).toBeInTheDocument();
    });

    it("renames the conversation from its header", async () => {
      openConversationWithoutTask();
      const patchCalls = () =>
        fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/conversations/conv-1") && init?.method === "PATCH");

      fireEvent.click(await screen.findByRole("button", { name: "제목 변경" }));
      const input = screen.getByRole("textbox", { name: "대화 제목" });
      expect(input).toHaveValue("New conversation");

      // Escape cancels without a request.
      fireEvent.change(input, { target: { value: "버려질 제목" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "대화 제목" })).not.toBeInTheDocument();
      expect(screen.getByText("New conversation")).toBeInTheDocument();

      // Enter while an IME is still composing is the syllable being
      // committed, not a save.
      fireEvent.click(screen.getByRole("button", { name: "제목 변경" }));
      const editing = screen.getByRole("textbox", { name: "대화 제목" });
      fireEvent.change(editing, { target: { value: "  배포 점검  " } });
      fireEvent.keyDown(editing, { key: "Enter", isComposing: true });
      expect(screen.getByRole("textbox", { name: "대화 제목" })).toBeInTheDocument();
      expect(patchCalls()).toHaveLength(0);

      fireEvent.keyDown(editing, { key: "Enter" });
      expect(await screen.findByText("배포 점검")).toBeInTheDocument();
      expect(patchCalls()).toHaveLength(1);
      expect(JSON.parse(String(patchCalls()[0][1]?.body))).toEqual({ title: "배포 점검" });
    });

    it("copies a message's original text, markdown source included", async () => {
      const now = new Date().toISOString();
      const reply = "## 결과\n\n- **완료**\n- `npm test` 통과";
      openConversationWithoutTask([
        { id: "m1", conversation_id: "conv-1", role: "user", content: "요청\n두 줄", created_at: now },
        { id: "m2", conversation_id: "conv-1", role: "assistant", content: reply, created_at: now }
      ]);

      const buttons = await screen.findAllByRole("button", { name: "메시지 복사" });
      expect(buttons).toHaveLength(2);

      fireEvent.click(buttons[1]);
      expect(await screen.findByRole("button", { name: "복사됨" })).toBeInTheDocument();
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(reply);

      fireEvent.click(buttons[0]);
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("요청\n두 줄"));
    });
  });
});
