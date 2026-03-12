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

| Document             | Description                          |
| -------------------- | ------------------------------------ |
| `2026-03-11.plan.md` | canonical system design and roadmap  |
| `Deployment.md`      | deployment and infrastructure model  |
| `TOOLS.md`           | local tool layer and workspace model |

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

Start both servers from the repo root:

```bash
pnpm dev
```

Start them separately when needed:

```bash
pnpm dev:api
pnpm dev:web
```

Default local URLs:

```text
Web Commander: http://127.0.0.1:5173
Orchestration API: http://127.0.0.1:8000
```

## Summary

Zenbar Agent Commander is a self-hosted orchestration control plane for AI coding agents.

Its core value is remote supervision, approval, and multi-project task control on top of the Codex App Server runtime.
