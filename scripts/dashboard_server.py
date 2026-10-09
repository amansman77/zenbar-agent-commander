"""Serves the built Web Commander and proxies /api to the Orchestration API.

This is what nginx did inside the old Docker dashboard image, run on the host
instead so the whole stack lives under launchd (see scripts/services.sh):

- static files from ZENBAR_DASHBOARD_DIST, with index.html for any path that
  is not a file, since the app routes on the client;
- /api/* forwarded to ZENBAR_API_UPSTREAM with the API token added, so the
  token stays on this machine and is never baked into the browser bundle;
- responses streamed through unbuffered, because runtime events reach the
  browser over SSE (GET /tasks/{id}/stream) and must arrive as they happen.

It uses only what the API's virtualenv already has (Starlette, httpx, uvicorn).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from starlette.routing import Route

DIST = Path(os.environ["ZENBAR_DASHBOARD_DIST"]).resolve()
UPSTREAM = os.getenv("ZENBAR_API_UPSTREAM", "http://127.0.0.1:18001").rstrip("/")
TOKEN = os.getenv("ZENBAR_API_TOKEN", "")

# Hop-by-hop headers belong to one connection and must not be forwarded.
# On the way back, Content-Length is dropped because the body is re-sent
# chunked. Content-Encoding is kept: aiter_raw passes the bytes through still
# encoded, so the header still describes them.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
}
# Date and Server are dropped because uvicorn adds its own, and a response
# would otherwise carry both.
_RESPONSE_DROP = _HOP_BY_HOP | {"content-length", "date", "server"}

# No read timeout: an SSE stream stays open for as long as the task page does.
client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=None))


async def healthz(_: Request) -> Response:
    return PlainTextResponse("ok\n")


async def proxy(request: Request) -> Response:
    path = request.path_params["path"]
    url = f"{UPSTREAM}/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    if TOKEN:
        headers["X-Zenbar-Token"] = TOKEN
    upstream_request = client.build_request(request.method, url, headers=headers, content=await request.body())
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        return PlainTextResponse(f"API unreachable: {exc}", status_code=502)
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers={k: v for k, v in upstream.headers.items() if k.lower() not in _RESPONSE_DROP},
        background=BackgroundTask(upstream.aclose),
    )


async def static(request: Request) -> Response:
    relative = request.path_params.get("path", "")
    candidate = (DIST / relative).resolve()
    # resolve() + is_relative_to keeps "../" out of the dist directory.
    if relative and candidate.is_relative_to(DIST) and candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})


@asynccontextmanager
async def lifespan(_: Starlette):
    yield
    await client.aclose()


app = Starlette(
    routes=[
        Route("/healthz", healthz),
        Route("/api/{path:path}", proxy, methods=["GET", "POST", "PUT", "PATCH", "DELETE"]),
        Route("/{path:path}", static),
    ],
    lifespan=lifespan,
)


if __name__ == "__main__":
    if not (DIST / "index.html").is_file():
        raise SystemExit(f"No built dashboard at {DIST}; run `sh scripts/services.sh deploy-web` first.")
    uvicorn.run(
        app,
        host=os.getenv("ZENBAR_DASHBOARD_HOST", "127.0.0.1"),
        port=int(os.getenv("ZENBAR_DASHBOARD_PORT", "8080")),
        log_level="warning",
    )
