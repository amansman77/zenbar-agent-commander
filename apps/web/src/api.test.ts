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
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("url builders with a relative API base (the Docker build)", () => {
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
