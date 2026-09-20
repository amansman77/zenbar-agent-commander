# Zenbar Agent Commander

Zenbar Agent Commander is a control plane for supervising AI coding agents.

It runs above the Codex App Server runtime and allows developers to monitor, approve, and orchestrate agent tasks remotely.

## Glossary

| Term                   | Meaning                     |
| ---------------------- | --------------------------- |
| Zenbar Agent Commander | 전체 시스템                |
| Web Commander          | 웹 UI                      |
| Mobile Commander       | iPhone app                 |
| Orchestration API      | Zenbar backend             |
| Codex App Server       | agent runtime              |
| Codex CLI              | local coding engine        |
| Task Workspace         | task isolation environment |

## Product Overview

Zenbar is a self-hosted orchestration layer for AI-assisted development.

It is designed for:

* remote supervision
* human approval
* multi-project orchestration
* mobile control

Zenbar is not an agent runtime. Zenbar is the control plane above the Codex App Server runtime.

## Canonical Architecture

```text
Web Commander / Mobile Commander
            ↓
Zenbar Orchestration API
            ↓
       Codex App Server
            ↓
        Codex Runtime
            ↓
Codex CLI / tools / filesystem / git
```

Zenbar Agent Commander runs as a control plane above the Codex App Server runtime.

## Component Responsibilities

| Component         | Responsibility          |
| ----------------- | ----------------------- |
| Web Commander     | task 생성, 상태 확인, diff 확인 |
| Orchestration API | task lifecycle 관리       |
| Codex App Server  | agent runtime           |
| Codex CLI         | 코드 작업 실행                |
| Local tools       | git / shell / test      |

Important rule:

* agent session lifecycle belongs to Codex App Server
* Zenbar does not implement its own agent runtime

## Approval Semantics

Agents may modify files inside a task workspace while a task is running.

```text
AI agents operate inside an isolated task workspace.

Human approval is required before a task result is accepted as final.
```

This means:

* the agent can work freely inside the task workspace
* pre-approval changes remain isolated workspace state
* only approved results are accepted as final

## Task Workspace

Each task runs inside an isolated workspace (branch or worktree).

Branch format:

```text
task/<slug>-<shortid>
```

Examples:

```text
task/fix-canonical-a1b2
task/add-dashboard-k3x1
```

Isolation options:

* Option A: git branch
* Option B: git worktree

## Agent Host

Zenbar Agent Commander runs on a self-hosted Agent Host machine.

```text
Agent Host Machine

├ Web Commander
├ Zenbar Orchestration API
├ Codex App Server
└ Codex CLI environment
```

External access is provided through:

```text
Tailscale
```

## Core Documents

| Document    | Description                                                 |
| ----------- | ----------------------------------------------------------- |
| `README.md` | this file: what Zenbar is, its architecture, and how to run it |
| `CLAUDE.md` | codebase map and conventions for anyone changing the code   |

## Guiding Principles

### Human-in-the-loop approval

Agents can work autonomously, but final acceptance requires human approval.

### Local-first execution

Agent execution should remain close to the real codebase and local developer tools.

### Lightweight orchestration

Zenbar focuses on supervision and orchestration rather than rebuilding the runtime layer.

## Status

Early prototype.

## Development

Run the dashboard in Docker, connected to the existing host API and agent runtime:

```bash
pnpm dev:api:external  # if the host API is not already running on port 18000
pnpm docker:dashboard
```

Open `http://localhost:8080`. The container serves the built UI and proxies API
requests (including SSE) to `host.docker.internal:18000`. The API and agent runtime
remain on the host so existing database, project paths, and task worktrees keep
working. The API must listen on `0.0.0.0` for the container to reach it. Its access
policy must permit the proxy: configure `ZENBAR_API_TOKEN` (preferred) or explicitly
allow unauthenticated remote access. The launcher reads the same `.env.local`
files as the host API and supplies the token to the proxy without embedding it in
the browser bundle. Docker publishes the dashboard on loopback only.

Override `ZENBAR_DOCKER_PORT` or `ZENBAR_API_UPSTREAM` to use another port or API.
Run `docker stop zenbar-dashboard` to stop it; rerun `pnpm docker:dashboard` to
rebuild and replace it. Docker Engine is sufficient; Compose is not required.

For Tailscale access to the Docker dashboard, stop the old development web server
on port 15173 and forward that tailnet port to the container:

```bash
tailscale serve --bg --tcp=15173 tcp://127.0.0.1:8080
# Optional HTTPS dashboard:
tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

With the macOS GUI install, use
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` if `tailscale` is not on PATH.
Open `http://<tailscale-ip>:15173` or `https://<magicdns-name>:8443`. Use TCP
forwarding for the IP URL; Tailscale's HTTP proxy routes by hostname. Both UI and
API requests use the Docker dashboard's same-origin `/api` proxy, so the browser
does not depend on the old host API port 18000.

To also run the API in Docker:

First finish active tasks, stop the host API, and run the Codex App Server
independently on port 18765. The API launcher refuses to migrate while the host API
port is still in use, preventing two control planes from sharing live tasks.

```bash
pnpm docker:database
pnpm docker:api
pnpm docker:dashboard
```

The dashboard automatically connects to `zenbar-api:8000` on the `zenbar` Docker
network. The API is also available on `http://localhost:18001` with its existing
token. SQLite runs inside the API process and stores its database and journals in
the persistent Docker volume `zenbar-data` at `/data/zenbar.db`; it needs no separate
database server container. `docker:database` uses SQLite's online backup API to
import a consistent snapshot of the host database, verifies the copy, and refuses
to overwrite an existing volume. The original host database is preserved. A
snapshot taken before host work finishes is only a staging copy: initialize a
fresh volume after stopping the host API for final migration, using
`ZENBAR_DOCKER_DATABASE_VOLUME` with the same value for both commands. Container
replacement preserves the volume; deleting the volume deletes its data.

The API mounts `~/Workspace`, task
workspaces, and Codex configuration/profile files. Absolute project and worktree
paths are preserved for the host Codex runtime. The runtime must already be
running on host port 18765; this container does not manage or stop it. If the host
API owns that runtime, keep it running until its active tasks finish and the
runtime is managed independently, before migrating. Other CLI engines need their Linux executables
and credentials installed in the API image. Host macOS native folder selection is
unavailable; use the web folder browser or specify the project path.

Overrides: `ZENBAR_DOCKER_API_PORT`, `ZENBAR_DOCKER_PROJECTS_ROOT`,
`ZENBAR_DOCKER_DATABASE_FILE` (snapshot source), `ZENBAR_DOCKER_DATABASE_VOLUME`,
and `ZENBAR_DOCKER_RUNTIME_URL`. The launcher runs as
the host user's UID/GID. Stop it with `docker stop zenbar-api`.

Start both servers from the repo root:

```bash
pnpm dev
```

Start both servers in external mode (`0.0.0.0` bind):

```bash
pnpm dev:external
```

Run external mode in background:

```bash
pnpm dev:external:bg
pnpm dev:external:stop
```

External mode default ports:

```text
Web Commander: 15173
Orchestration API: 18000
```

Start them separately when needed:

```bash
pnpm dev:api
pnpm dev:web
```

External mode (separate):

```bash
pnpm dev:api:external
pnpm dev:web:external
```

Default local URLs:

```text
Web Commander: http://127.0.0.1:5173
Orchestration API: http://127.0.0.1:8000
```

External mode environment variables:

```text
ZENBAR_PUBLIC_HOST          # preferred host/IP used for VITE_API_BASE_URL (optional)
ZENBAR_API_HOST             # default: 0.0.0.0
ZENBAR_API_PORT             # default: 18000
ZENBAR_WEB_HOST             # default: 0.0.0.0
ZENBAR_WEB_PORT             # default: 15173
VITE_API_BASE_URL           # explicit override for web API target
```

Notes:

* `dev:web:external` auto-detects a Tailscale IPv4 when available.
* For iPhone/remote access in a tailnet, open `http://<agent-host-tailscale-ip>:5173`.

## Summary

Zenbar Agent Commander is a self-hosted orchestration control plane for AI coding agents.

Its core value is remote supervision, approval, and multi-project task control on top of the Codex App Server runtime.
