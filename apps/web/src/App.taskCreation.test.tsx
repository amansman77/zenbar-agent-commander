// App integration tests covering creating projects and tasks: discovery autofill, the model rules the
// form enforces, the mobile flow, and saved prompts.
//
// The fetch mock, fixture data and shared setup live in test/appHarness.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { fetchMock, fixtures, renderApp, resetAppTest } from "./test/appHarness";

describe("App", () => {
  beforeEach(resetAppTest);

  function openAttachmentConversation(messages: unknown[] = []) {
    fixtures.conversationDetail = {
      id: "conv-attachments", title: "첨부파일 테스트", project_id: "project-1", task_id: null,
      task_status: null, messages,
    };
    window.localStorage.setItem("zenbar:lastView", JSON.stringify({
      desktopView: "chat", selectedConversationId: "conv-attachments", mobileScreen: "conversation-detail",
    }));
    renderApp();
  }

  function openImageConversation() {
    openAttachmentConversation([{
      id: "image-message", conversation_id: "conv-attachments", role: "user", content: "이미지 확인",
      created_at: new Date().toISOString(), attachments: [{ id: "image-1", name: "사진.PNG", size: 10 }],
    }]);
  }

  it("opens an image viewer, keeps download available and releases its preview on close", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:test-image");
    const revokeObjectURL = vi.fn();
    const OriginalURL = URL;
    vi.stubGlobal("URL", class extends OriginalURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    const close = vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
    try {
      openImageConversation();
      const trigger = await screen.findByRole("button", { name: /사진.PNG/ });
      trigger.focus();
      fireEvent.click(trigger);
      const viewer = await screen.findByRole("dialog", { name: "사진.PNG 이미지 미리보기" });
      expect(await within(viewer).findByRole("img", { name: "사진.PNG" })).toHaveAttribute("src", "blob:test-image");
      expect(within(viewer).getByRole("link", { name: "다운로드" })).toHaveAttribute("download", "사진.PNG");
      fireEvent(viewer, new Event("cancel", { bubbles: false, cancelable: true }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-image");
      expect(trigger).toHaveFocus();
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("button", { name: "이미지 미리보기 닫기" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      showModal.mockRestore();
      close.mockRestore();
      vi.stubGlobal("URL", OriginalURL);
    }
  });

  it("shows a download fallback when an image cannot be fetched", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    const close = vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
    try {
      fixtures.attachmentDownloadError = true;
      openImageConversation();
      fireEvent.click(await screen.findByRole("button", { name: /사진.PNG/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent("다운로드하여 확인");
      expect(screen.getByRole("link", { name: "다운로드" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "이미지 미리보기 닫기" }));
    } finally {
      showModal.mockRestore();
      close.mockRestore();
    }
  });

  it("uploads files before sending and displays downloadable attachments", async () => {
    openAttachmentConversation();
    const picker = await screen.findByLabelText("첨부파일 선택");
    const file = new File(["requirements"], "요구사항.txt", { type: "text/plain" });
    fireEvent.change(picker, { target: { files: [file] } });
    expect(screen.getByRole("list", { name: "전송할 첨부파일" })).toHaveTextContent("요구사항.txt");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const link = await screen.findByRole("link", { name: /요구사항.txt/ });
    expect(link).toHaveAttribute("download", "요구사항.txt");
    expect(link).toHaveAttribute("href", expect.stringContaining("/conversations/conv-attachments/attachments/attachment-1"));
    const messageCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/messages") && init?.method === "POST");
    expect(JSON.parse(String(messageCall?.[1]?.body))).toMatchObject({ content: "", attachment_ids: ["attachment-1"] });
    expect(screen.queryByRole("list", { name: "전송할 첨부파일" })).not.toBeInTheDocument();
  });

  it("keeps drafts on upload failure and supports retry and removal", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    openAttachmentConversation();
    fixtures.attachmentUploadError = true;
    const picker = await screen.findByLabelText("첨부파일 선택");
    fireEvent.change(picker, { target: { files: [new File(["data"], "notes.txt")] } });
    fireEvent.change(screen.getByPlaceholderText("메시지를 입력하세요..."), { target: { value: "확인해주세요" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    expect(screen.getByDisplayValue("확인해주세요")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "전송할 첨부파일" })).toHaveTextContent("notes.txt");
    fixtures.attachmentUploadError = false;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("link", { name: /notes.txt/ });
    fireEvent.change(picker, { target: { files: [new File(["other"], "remove.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "remove.txt 첨부 취소" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "전송할 첨부파일" })).not.toBeInTheDocument());
    alertMock.mockRestore();
  });

  it("rejects empty files without uploading", async () => {
    openAttachmentConversation();
    fireEvent.change(await screen.findByLabelText("첨부파일 선택"), { target: { files: [new File([], "empty.txt")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("빈 파일");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("reuses completed uploads when retrying a partially failed batch", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    openAttachmentConversation();
    fixtures.attachmentFailureName = "second.txt";
    fireEvent.change(await screen.findByLabelText("첨부파일 선택"), {
      target: { files: [new File(["first"], "first.txt"), new File(["second"], "second.txt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(fixtures.conversationAttachments).toHaveLength(1);
    fixtures.attachmentFailureName = null;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("link", { name: /second.txt/ });
    expect(fixtures.conversationAttachments).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/attachments?name=first.txt"))).toHaveLength(1);
    alertMock.mockRestore();
  });

  it("autofills project fields from repository discovery and keeps them editable", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "새 프로젝트" }));
    // Picking a repo goes through the folder browser: open it, then confirm
    // the folder it lands on, which is what triggers discovery.
    fireEvent.click(await screen.findByRole("button", { name: "Browse folder" }));
    const confirmFolder = await screen.findByRole("button", { name: "이 폴더 선택" });
    // Disabled until the browse query resolves — clicking early is a no-op.
    await waitFor(() => expect(confirmFolder).toBeEnabled());
    fireEvent.click(confirmFolder);

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
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: "새 태스크" }));
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

  it("requires explicit model selection before task creation", async () => {
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];

    renderApp();

    // The desktop Task Detail view's own runtime-models query (for its
    // "Retry model" dropdown) is scoped to the selected task's engine and
    // only fires once a task is selected -- see runtimeModelsQuery in
    // App(). Nothing here selects a task, so it deliberately does not fire;
    // this test only cares about the New Task form's own per-engine query.

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: "새 태스크" }));

    const createButton = await screen.findByRole("button", { name: "Create task" });
    expect(createButton).toBeDisabled();

    // TaskForm fetches its own model list (per-engine) once it mounts, so
    // wait for the option to actually be there before selecting it.
    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveTextContent("GPT-5.4");
    });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "GPT-5.4" } });
    await waitFor(() => {
      expect(createButton).toBeEnabled();
    });
  });

  it("does not submit the desktop task form via Enter before a model is selected", async () => {
    // Regression test: the desktop TaskForm's submit *button* is correctly
    // disabled while !canSubmit, but the <form>'s onSubmit used to call
    // submitTask() unconditionally. Pressing Enter in a text field submits
    // a <form> natively regardless of the submit button's disabled state,
    // so this used to send a request with an empty/not-yet-loaded model
    // straight to the API and get a 400 back.
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: "새 태스크" }));

    const createButton = await screen.findByRole("button", { name: "Create task" });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix sitemap canonical" } });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Analyze the repository and fix canonical tag generation." }
    });

    const postTasksCallsBefore = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/tasks") && (init as RequestInit | undefined)?.method === "POST"
    ).length;

    fireEvent.submit(createButton.closest("form")!);

    // The mutation dispatch (if the guard is missing) goes through
    // react-query's async machinery before fetch is actually called, so
    // give it a beat to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const postTasksCallsAfter = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/tasks") && (init as RequestInit | undefined)?.method === "POST"
    ).length;
    expect(postTasksCallsAfter).toBe(postTasksCallsBefore);
  });

  it("submits task through mobile 3-step creation flow", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];

    renderApp();

    // Mobile opens on Conversations; projects live one tap away.
    fireEvent.click(await screen.findByRole("button", { name: "Projects" }));
    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: "새 태스크" }))[0]);

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

  it("imports a selected prompt from another project as a copy", async () => {
    // Prompts were project-scoped with no way to reuse one written for a
    // different project short of retyping it -- 가져오기 copies (creates
    // new rows), not links/shares, matching how prompts already behave
    // everywhere else in this screen.
    window.localStorage.setItem(
      "zenbar:lastView",
      JSON.stringify({
        mobileScreen: "projects",
        desktopView: "workspace",
        selectedConversationId: null,
        selectedProjectId: null,
        selectedTaskId: null
      })
    );
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      },
      {
        id: "project-2",
        name: "other-project",
        repo_path: "/Users/hosung/Workspace/zenbar/other-project",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.projectPrompts = {
      "project-2": [
        {
          id: "prompt-source-1",
          project_id: "project-2",
          title: "Triage a bug",
          content: "Look at the failing test and fix it.",
          position: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]
    };

    renderApp();

    const project1Row = (await screen.findAllByText("agent-commander"))[0].closest(".list-item") as HTMLElement;
    fireEvent.click(within(project1Row).getByRole("button", { name: "Prompts" }));

    fireEvent.click(await screen.findByRole("button", { name: "가져오기" }));
    fireEvent.change(await screen.findByLabelText("가져올 프로젝트"), { target: { value: "project-2" } });

    fireEvent.click(await screen.findByText("Triage a bug"));
    fireEvent.click(screen.getByRole("button", { name: "가져오기 (1)" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/projects\/project-1\/prompts$/),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ title: "Triage a bug", content: "Look at the failing test and fix it." })
        })
      );
    });
    // The dialog closes and the freshly copied prompt shows up in project-1's own list.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Triage a bug")).toBeInTheDocument();
  });

  it("offers global prompts alongside a project's own in the saved-prompt picker", async () => {
    // Global prompts (not scoped to any project) are meant to save
    // copy-pasting the same reusable prompt (e.g. "refactor this") into
    // every project's own list -- they should show up in every project's
    // task-creation dropdown without the user doing anything per-project.
    fixtures.projects = [
      {
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }
    ];
    fixtures.projectPrompts = {
      "project-1": [
        {
          id: "prompt-own-1",
          project_id: "project-1",
          title: "Project-specific",
          content: "Only relevant to this project.",
          position: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]
    };
    fixtures.globalPrompts = [
      {
        id: "global-1",
        title: "Refactor",
        content: "Refactor this for clarity and remove duplication.",
        position: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /agent-commander/i }));
    fireEvent.click(await screen.findByRole("button", { name: "새 태스크" }));

    const picker = await screen.findByLabelText("저장된 프롬프트");
    const optionLabels = within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(optionLabels).toContain("🌐 Refactor");
    expect(optionLabels).toContain("Project-specific");

    fireEvent.change(picker, { target: { value: "global-1" } });
    expect(screen.getByPlaceholderText("Analyze the repository and fix canonical tag generation.")).toHaveValue(
      "Refactor this for clarity and remove duplication."
    );
  });
});
