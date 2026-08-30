// Shared test harness for the App integration suites.
//
// Owns the fetch mock standing in for the Orchestration API, the fixture data
// each test seeds it with, and the reset that runs before every test. Split
// out of App.test.tsx so the suites can be grouped by feature without each one
// carrying its own copy of a 180-line mock.
//
// `fixtures` is a mutable object rather than loose module variables because a
// test file cannot reassign an imported binding: tests set `fixtures.tasks =
// [...]`, and the fetch mock reads the same object.

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../App";

type Row = Record<string, unknown>;

export const fixtures: {
  projects: Row[];
  tasks: Row[];
  taskDetail: Row | null;
  taskEvents: Row[];
  taskDiff: Row;
  conversations: Row[];
  conversationCounts: Record<string, number>;
  projectPrompts: Record<string, Row[]>;
  globalPrompts: Row[];
} = {
  projects: [],
  tasks: [],
  taskDetail: null,
  taskEvents: [],
  taskDiff: { files_changed: [], summary: "", raw_diff: null },
  conversations: [],
  conversationCounts: {},
  projectPrompts: {},
  globalPrompts: []
};

export const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input.toString();
  if (url.endsWith("/runtime/models?engine=antigravity")) {
    return new Response(
      JSON.stringify({
        source: "runtime",
        models: [{ id: "default" }, { id: "gemini-3.7-flash-high" }]
      }),
      { status: 200 }
    );
  }
  if (url.endsWith("/runtime/models")) {
    return new Response(
      JSON.stringify({
        source: "runtime",
        models: [{ id: "GPT-5.4" }, { id: "GPT-5.3-Codex" }]
      }),
      { status: 200 }
    );
  }
  if (url.includes("/fs/browse")) {
    return new Response(
      JSON.stringify({
        path: "/Users/hosung/Workspace/zenbar/agent-commander",
        parent: "/Users/hosung/Workspace/zenbar",
        entries: []
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
    fixtures.projects = [project];
    return new Response(JSON.stringify(project), { status: 200 });
  }
  if (url.endsWith("/projects")) {
    return new Response(JSON.stringify(fixtures.projects), { status: 200 });
  }
  if (url.endsWith("/projects/project-1/tasks")) {
    return new Response(JSON.stringify(fixtures.tasks), { status: 200 });
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
    fixtures.taskDetail = createdTask;
    fixtures.tasks = [createdTask];
    return new Response(JSON.stringify(createdTask), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/respond") && init?.method === "POST") {
    fixtures.taskDetail = {
      ...(fixtures.taskDetail ?? {}),
      status: "running",
      pending_interaction_type: null,
      pending_request_id: null,
      pending_request_payload_json: null,
      pending_questions: []
    };
    return new Response(JSON.stringify(fixtures.taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/approve") && init?.method === "POST") {
    fixtures.taskDetail = { ...(fixtures.taskDetail ?? {}), status: "running" };
    return new Response(JSON.stringify(fixtures.taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/retry") && init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    fixtures.taskDetail = { ...(fixtures.taskDetail ?? {}), status: "starting", model: payload.model ?? (fixtures.taskDetail as Record<string, unknown> | null)?.model };
    return new Response(JSON.stringify(fixtures.taskDetail), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1")) {
    return new Response(JSON.stringify(fixtures.taskDetail), { status: 200 });
  }
  if (url.includes("/tasks/task-1/events")) {
    // Mirrors the real endpoint: ?exclude_types=... filters server-side and
    // reports the hidden count via a response header rather than the body.
    const excludeTypes = new URL(url).searchParams.get("exclude_types")?.split(",") ?? [];
    const filtered =
      excludeTypes.length > 0 ? fixtures.taskEvents.filter((e) => !excludeTypes.includes(e.type as string)) : fixtures.taskEvents;
    return new Response(JSON.stringify(filtered), {
      status: 200,
      headers: excludeTypes.length > 0 ? { "X-Excluded-Event-Count": String(fixtures.taskEvents.length - filtered.length) } : {}
    });
  }
  if (url.endsWith("/conversations/counts")) {
    return new Response(JSON.stringify(fixtures.conversationCounts), { status: 200 });
  }
  if (url.includes("/conversations") && url.includes("preview_count")) {
    // Mirrors list_conversations' own preview_count filtering: cap each
    // project to its preview_count most-recently-updated conversations,
    // keeping any with an active task regardless of position.
    const previewCount = Number(new URL(url).searchParams.get("preview_count"));
    const seenPerProject: Record<string, number> = {};
    const activeStatuses = new Set(["queued", "starting", "running", "waiting_user_input", "waiting_result_approval"]);
    const preview = fixtures.conversations.filter((conv) => {
      const key = String(conv.project_id ?? "__no_project__");
      const seen = seenPerProject[key] ?? 0;
      seenPerProject[key] = seen + 1;
      return seen < previewCount || activeStatuses.has(String(conv.task_status ?? ""));
    });
    return new Response(JSON.stringify(preview), { status: 200 });
  }
  if (url.endsWith("/conversations")) {
    return new Response(JSON.stringify(fixtures.conversations), { status: 200 });
  }
  if (url.endsWith("/tasks/task-1/diff")) {
    return new Response(JSON.stringify(fixtures.taskDiff), { status: 200 });
  }
  const promptsMatch = url.match(/\/projects\/([^/]+)\/prompts$/);
  if (promptsMatch && init?.method === "POST") {
    const [, ownerProjectId] = promptsMatch;
    const payload = JSON.parse(String(init.body));
    const created = {
      id: `prompt-${(fixtures.projectPrompts[ownerProjectId] ?? []).length + 1}`,
      project_id: ownerProjectId,
      title: payload.title,
      content: payload.content,
      position: (fixtures.projectPrompts[ownerProjectId] ?? []).length + 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    fixtures.projectPrompts[ownerProjectId] = [...(fixtures.projectPrompts[ownerProjectId] ?? []), created];
    return new Response(JSON.stringify(created), { status: 201 });
  }
  if (promptsMatch) {
    return new Response(JSON.stringify(fixtures.projectPrompts[promptsMatch[1]] ?? []), { status: 200 });
  }
  // Global (not project-scoped) prompts -- checked after promptsMatch above,
  // whose project-scoped regex already returned for that shape, so anything
  // still ending in "/prompts" here is the unscoped /prompts endpoint.
  if (url.endsWith("/prompts") && init?.method === "POST") {
    const payload = JSON.parse(String(init.body));
    const created = {
      id: `global-prompt-${fixtures.globalPrompts.length + 1}`,
      title: payload.title,
      content: payload.content,
      position: fixtures.globalPrompts.length + 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    fixtures.globalPrompts = [...fixtures.globalPrompts, created];
    return new Response(JSON.stringify(created), { status: 201 });
  }
  if (url.endsWith("/prompts")) {
    return new Response(JSON.stringify(fixtures.globalPrompts), { status: 200 });
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

/** The beforeEach every App suite shares: fresh fixtures, clean storage, and a
 *  desktop viewport seeded onto the workspace view. */
export function resetAppTest() {
  fetchMock.mockClear();
  fixtures.projects = [];
  fixtures.tasks = [];
  fixtures.taskDetail = null;
  fixtures.taskEvents = [];
  fixtures.taskDiff = { files_changed: [], summary: "", raw_diff: null };
  fixtures.conversations = [];
  fixtures.conversationCounts = {};
  fixtures.projectPrompts = {};
  fixtures.globalPrompts = [];
  window.localStorage.clear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined)
    }
  });
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 });
  window.dispatchEvent(new Event("resize"));
  // Desktop now lands on the conversation view (matching mobile), but most
  // suites exercise the project/task workspace surface. Seed the
  // persisted view so they open directly on it; the desktop chat view has
  // its own test that clears this.
  window.localStorage.setItem(
    "zenbar:lastView",
    JSON.stringify({
      mobileScreen: "conversations",
      desktopView: "workspace",
      selectedConversationId: null,
      selectedProjectId: null,
      selectedTaskId: null
    })
  );
}

/** Renders the whole app the way every integration test needs it. */
export function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>
  );
}
