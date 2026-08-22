# Zenbar Agent Commander Deployment Guide

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

## Overview

Zenbar Agent Commander is deployed as a self-hosted orchestration control plane on an Agent Host machine.

Zenbar runs above the Codex App Server runtime rather than implementing its own runtime.

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

## Agent Host Structure

```text
Agent Host Machine

├ Web Commander
├ Zenbar Orchestration API
├ Codex App Server
└ Codex CLI environment
```

This keeps the control plane and runtime close to the real repositories and local developer tools.

## Service Responsibilities

| Component         | Responsibility          |
| ----------------- | ----------------------- |
| Web Commander     | task 생성, 상태 확인, diff 확인 |
| Orchestration API | task lifecycle 관리       |
| Codex App Server  | agent runtime           |
| Codex CLI         | 코드 작업 실행                |
| Local tools       | git / shell / test      |

## External Access

External access is provided through:

```text
Tailscale
```

Recommended devices on the tailnet:

* Agent Host
* personal laptop
* iPhone
* home workstation

External dev startup:

```bash
pnpm dev:external
```

Overrides:

```text
ZENBAR_PUBLIC_HOST
ZENBAR_API_HOST
ZENBAR_API_PORT
ZENBAR_WEB_HOST
ZENBAR_WEB_PORT
VITE_API_BASE_URL
```

## Deployment Principles

### Local-first runtime

Agent execution should stay on the Agent Host near the real repositories, shell environment, and test tools.

### Remote supervision

Web Commander and Mobile Commander provide remote visibility and approval without exposing public ports.

### Human approval

Agents may work in isolated task workspaces, but approval is required before a task result is accepted as final.

## Task Workspace Model

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

## Runtime Requirements

The Agent Host should provide:

* Codex App Server
* Codex CLI environment
* local repository access
* git, shell, and test tooling
* stable network access
* an always-on machine

Recommended hosts:

* Mac mini
* Linux home server
* dedicated dev machine

## Data Storage

MVP storage:

```text
SQLite
```

Stored data:

* projects
* tasks
* events
* approvals

Future upgrade:

```text
PostgreSQL
```

## Backup Strategy

Important data:

* task history
* event logs
* approvals

Recommended backup cadence:

```text
daily
```

## Security Model

The deployment assumes:

* single-user or trusted-device usage
* private network access
* local control of the Agent Host

Security comes from:

* Tailscale private networking
* device authentication
* keeping the control plane off the public internet

## Summary

Zenbar Agent Commander is deployed as a self-hosted control plane on top of the Codex App Server runtime.

Its deployment model prioritizes local execution, isolated task workspaces, private remote access, and human approval.
