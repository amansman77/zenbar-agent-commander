// Regression tests for the URL builders in api.ts.
//
// These exist because of a real outage: the Docker image sets a *relative*
// VITE_API_BASE_URL (/api), and `new URL("/api/...")` with no base throws
// `TypeError: Invalid URL`. workspaceFileUrl is called during render, so the
// throw unmounted the React tree and the dashboard was a blank white page for
// any conversation whose message mentioned an image path. The dev scripts set
// an absolute base, which is why it only appeared once deployment moved to
// Docker -- so both shapes are pinned here.

// API_BASE is read from import.meta.env at module load, so each case has to
// stub the env and re-import rather than share one instance. VITE_API_TOKEN is
// stubbed empty too: the developer's own apps/web/.env.local otherwise supplies
// a real token, which would both make these assertions machine-dependent and
// print the live token into failure output.
async function loadApi(base: string) {
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", base);
  vi.stubEnv("VITE_API_TOKEN", "");
  return (await import("./api")).api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("conversation attachments", () => {
  it("fetches previews with header authentication and cancellation", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "/api");
    vi.stubEnv("VITE_API_TOKEN", "test-only-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response("image"));
    vi.stubGlobal("fetch", fetchMock);
    const api = (await import("./api")).api;
    const controller = new AbortController();
    const blob = await api.getConversationAttachment("conv-1", "file-1", controller.signal);
    expect(blob.size).toBe(5);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1/attachments/file-1", {
      headers: { "X-Zenbar-Token": "test-only-token" }, signal: controller.signal,
    });
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    await expect(api.getConversationAttachment("conv-1", "file-1", controller.signal)).rejects.toThrow("첨부 이미지를");
  });
  it("keeps authentication when sending raw file bytes", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "/api");
    vi.stubEnv("VITE_API_TOKEN", "test-only-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "file-1", name: "한글.txt", size: 4 })));
    vi.stubGlobal("fetch", fetchMock);
    const api = (await import("./api")).api;
    const file = new File(["test"], "한글.txt");
    await api.uploadConversationAttachment("conv-1", file);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-1/attachments?name=%ED%95%9C%EA%B8%80.txt", {
      method: "POST", body: file,
      headers: { "Content-Type": "application/octet-stream", "X-Zenbar-Token": "test-only-token" },
    });
    expect(api.conversationAttachmentUrl("conv-1", "file-1")).toBe(
      `${window.location.origin}/api/conversations/conv-1/attachments/file-1?token=test-only-token`
    );
  });
});

describe("url builders with a relative API base (the deployed dashboard build)", () => {
  it("workspaceFileUrl returns an absolute url instead of throwing", async () => {
    const api = await loadApi("/api");
    const url = api.workspaceFileUrl("task-1", "/tmp/shot.png");
    expect(url).toBe(`${window.location.origin}/api/tasks/task-1/workspace-file?path=%2Ftmp%2Fshot.png`);
  });

  it("streamUrl returns an absolute url instead of throwing", async () => {
    const api = await loadApi("/api");
    expect(api.streamUrl("task-1")).toBe(`${window.location.origin}/api/tasks/task-1/stream`);
  });
});

describe("url builders with an absolute API base (the dev scripts)", () => {
  it("keeps the configured origin rather than the page's", async () => {
    const api = await loadApi("http://100.125.118.91:18000");
    expect(api.workspaceFileUrl("task-1", "docs/a.png")).toBe(
      "http://100.125.118.91:18000/tasks/task-1/workspace-file?path=docs%2Fa.png"
    );
    expect(api.streamUrl("task-1")).toBe("http://100.125.118.91:18000/tasks/task-1/stream");
  });
});
