import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith("/projects")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  })
);

vi.stubGlobal(
  "EventSource",
  class {
    close() {}
  }
);

describe("App", () => {
  it("renders Web Commander shell", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Web Commander")).toBeInTheDocument();
    expect(screen.getByText("Task Workspace")).toBeInTheDocument();
  });
});
