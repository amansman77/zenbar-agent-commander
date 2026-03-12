import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

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
    return new Response(
      JSON.stringify({
        id: "project-1",
        name: "agent-commander",
        repo_path: "/Users/hosung/Workspace/zenbar/agent-commander",
        default_branch: "main",
        created_at: new Date().toISOString()
      }),
      { status: 200 }
    );
  }
  if (url.endsWith("/projects")) {
    return new Response(JSON.stringify([]), { status: 200 });
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
});
