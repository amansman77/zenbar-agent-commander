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

### Running Zenbar as services (launchd)

The day-to-day deployment is three launchd user agents on the Mac, all bound to
loopback:

| Agent | Serves |
| ----- | ------ |
| `com.zenbar.app-server` | Codex App Server, `ws://127.0.0.1:18765` |
| `com.zenbar.api` | Orchestration API, `http://127.0.0.1:18001` |
| `com.zenbar.dashboard` | Web Commander, `http://127.0.0.1:8080`, proxying `/api` (SSE included) to the API |

```bash
pnpm services:install     # write the plists and start all three
pnpm services:status
pnpm services:restart     # all, or: sh scripts/services.sh restart api
pnpm deploy:web           # rebuild the dashboard bundle; served live, no restart
pnpm services:uninstall
```

Each agent starts at login and is restarted if it exits. The API and the App
Server read both `.env.local` files. The dashboard adds `ZENBAR_API_TOKEN` to
each proxied request, so the token is never embedded in the browser bundle.
Logs are in `~/Library/Logs/com.zenbar.*.log`.

The database is `~/.zenbar/zenbar.db` (override the directory with
`ZENBAR_HOME`), deliberately outside the repo: `services/api/zenbar.db` is the
development database that `pnpm dev` uses. The built dashboard goes to
`~/.zenbar/dashboard`, so a development `pnpm build` never replaces what is
being served. After pulling API changes, run `sh scripts/services.sh restart api`.
After pulling web changes, run `pnpm deploy:web`.

This used to run in Docker. It moved to launchd because the CLI engines
(`claude`, `agy`, `grok`) and their logins only exist on the host. Inside a
container, those engines could not run a task, and their usage readouts came
back empty.

For Tailscale access, forward a tailnet port to the dashboard:

```bash
tailscale serve --bg --tcp=15173 tcp://127.0.0.1:8080
# Optional HTTPS dashboard:
tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

With the macOS GUI install, use
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` if `tailscale` is not on PATH.
Open `http://<tailscale-ip>:15173` or `https://<magicdns-name>:8443`. Use TCP
forwarding for the IP URL; Tailscale's HTTP proxy routes by hostname. Both the UI
and API requests go through the dashboard's same-origin `/api` proxy.

`ZENBAR_WORKSPACE_ROOT` must be a path with no symlink below the top level.
Codex's sandbox resolves a top-level alias such as `/tmp -> /private/tmp` but rejects a writable root with a symlink
under it. Pointing the root at a symlink (a `/tmp/zenbar-task-workspaces` that
links into the repo, say) makes every one of the agent's file and command tools
fail while the task itself still reports as running; the API now refuses such a
root when it prepares a workspace.

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
