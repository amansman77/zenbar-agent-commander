# Zenbar Agent Commander Tools

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

## Purpose

This document defines the local tool layer used by the Codex runtime.

Zenbar does not provide its own runtime. Agent execution is handled by Codex App Server, which uses Codex CLI and host-local tools to work inside a task workspace.

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

## Tool Layer Responsibilities

| Component         | Responsibility          |
| ----------------- | ----------------------- |
| Web Commander     | task 생성, 상태 확인, diff 확인 |
| Orchestration API | task lifecycle 관리       |
| Codex App Server  | agent runtime           |
| Codex CLI         | 코드 작업 실행                |
| Local tools       | git / shell / test      |

The local tool layer is the environment available to the runtime, not a separate Zenbar execution engine.

## Local Tools

The Codex runtime may use:

* git
* shell commands
* test commands
* docker when required by the repository
* filesystem access inside the task workspace

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

## Approval Semantics

Agents operate inside an isolated task workspace.

Human approval is required before a task result is accepted as final.

This means:

* the runtime may modify files inside the task workspace while the task is active
* isolated workspace state is not the same as an accepted final result
* review and approval decide when a result is accepted

## Example Tool Usage

Typical local operations may include:

```text
git checkout -b task/fix-canonical-a1b2
npm test
pytest
docker compose up
```

These are examples of tools used by the runtime, not workflow ownership by Zenbar.

## Security Considerations

Because the runtime uses local developer tools on the Agent Host:

* only trusted users should create tasks
* repository paths should be validated
* task workspaces should stay isolated from unrelated work

## Summary

Zenbar Agent Commander relies on Codex App Server for runtime execution and uses Codex CLI plus local tools as the execution layer.

The primary design goal is to keep orchestration separate from runtime while preserving isolated task workspaces and human approval.
