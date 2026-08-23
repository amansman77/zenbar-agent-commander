# CLAUDE.md

Codebase map for AI agents working in this repository. Product-level framing
(what Zenbar is and why) lives in `README.md`; this file is about where code
lives, how a request flows, and what will bite you.

## What this is

Zenbar Agent Commander is a **control plane**, not an agent runtime. It creates
tasks, hands them to an agent runtime (Codex App Server by default, or a CLI
engine), watches the resulting event stream, and lets a human approve the
result. Zenbar never implements agent execution itself.

```
Web Commander (apps/web)
        │  HTTP + SSE
Orchestration API (services/api)
        │  RuntimeAdapter
Codex App Server (WebSocket) │ claude / grok / agy CLIs
        │
git worktree per task
```

## Repo layout

```
apps/web/            React + Vite web UI ("Web Commander")
packages/shared/     TypeScript types mirroring the API schemas
services/api/        FastAPI backend ("Orchestration API")
scripts/             dev server launchers (local and external/Tailscale mode)
```

`README.md` and this file are the only prose docs, on purpose. New context
belongs in whichever of the two it fits — README for what Zenbar is, this file
for how the code is arranged — rather than in a third document that nothing
links to.

## Backend — `services/api/app/`

Every module has a docstring; read it before reading the code.

| Layer | Files |
| ----- | ----- |
| HTTP | `main.py` (app wiring only), `routers/*.py`, `security.py` |
| Singletons | `runtime_registry.py` — engine adapters, `TaskOrchestrator`, model catalogs |
| Orchestration | `service.py` — `TaskOrchestrator`, the task lifecycle |
| Persistence | `models.py` (ORM), `repository/` (all DB access + serializers), `db.py` |
| Runtime | `runtime/` (adapter interface + Codex WebSocket adapter + mock + factory), `claude_adapter.py`, `grok_adapter.py`, `antigravity_adapter.py`, `cli_adapter_git.py` |
| Workspace | `workspace.py` (creates/removes the worktree), `workspace_git.py` (commit/push/diff inside it), `codex_project_trust.py` |
| Support | `schemas.py`, `streaming.py`, `ttl_cache.py`, `model_catalog.py`, `pr_info.py`, `github_pr.py`, `repo_discovery.py`, `codex_profiles.py`, `app_server_manager.py` |

**Where endpoints live.** `main.py` only builds the app (lifespan, CORS, the
global auth dependency, `include_router`). Endpoints are grouped by resource:

```
routers/projects.py         /projects, /projects/discover, /projects/{id}/tasks
routers/project_prompts.py  /projects/{id}/prompts, /projects/{id}/pipelines
routers/conversations.py    /conversations...
routers/tasks.py            /tasks..., /sessions/{id}/turns
routers/runtime_info.py     /runtime/engines|models|profiles|skills|usage
routers/fs.py               /fs/browse
```

Routers import shared state from `runtime_registry.py`, never from `main.py` —
that is what keeps `main.py → routers → runtime_registry` acyclic. Helpers used
by more than one router live in `routers/common.py`.

**The repository package.** `repository/` is every read and write of the ORM
models, split by subject in dependency order: `naming` → `projects` → `prompts`
→ `tasks` → `events` → `conversations`, with `serializers.py` holding the
model-to-schema conversions. `events.py::append_event` is the single write path
for anything a runtime reports, which is why it is also what moves a task's
status and mirrors assistant messages into the conversation. Import from
`.repository`, not its submodules.

**The runtime package.** `runtime/` holds the `RuntimeAdapter` interface
(`base.py`) and the two adapters that ship with it — `app_server.py` for Codex
over WebSocket, `mock.py` for tests — plus `factory.py`, which builds one
adapter per engine at startup. The CLI engines live in `app/*_adapter.py` and
import `RuntimeAdapter` from the package. Import from `.runtime`, not its
submodules; the CLI adapters are imported lazily inside `factory.py` because
they import back from here.

**Layering rule:** routers do HTTP concerns only. Anything touching a runtime or
a task's state goes through `TaskOrchestrator`; anything touching the database
goes through the `repository` package. New code in a router should not use the ORM
session directly — `routers/conversations.py` still does for pipeline setup and
for session bookkeeping around orchestrator calls, which is a known exception,
not a pattern to copy.

**How a task runs.** A user message on a conversation
(`routers/conversations.py`) creates a task, then
`TaskOrchestrator.start_task()` prepares a git worktree, asks the engine's
`RuntimeAdapter` to start a session, and spawns a background consumer of that
session's events. Each event is normalized and persisted by the `repository`
package,
may move the task's status, and is fanned out over SSE
(`streaming.py` → `GET /tasks/{id}/stream`) to the UI.

**Task status.** Runtime events drive the status; the mapping is
`repository.map_status_from_event`. The two waiting states are deliberately
distinct and have been conflated before: `waiting_user_input` means the agent
asked the *user* a question mid-run and the answer goes back to the runtime,
while `waiting_result_approval` means the agent finished and a human has to
accept the result. Only the latter is approvable (`can_approve`), and for an
execute-mode task, approving it is also what merges the PR the agent opened
(`routers/tasks.py::merge_task_pull_request`, best-effort by design).

## Frontend — `apps/web/src/`

```
App.tsx        root: selection state, top-level queries/mutations, mobile vs desktop shell
api.ts         every HTTP call to the API
screens/       full surfaces (conversation list, conversation detail, prompts)
components/    reusable UI (diff view, timeline, forms, modals, badges)
components/prompts/  saved-prompt and pipeline editing
hooks/         data + browser hooks (SSE stream, breakpoint, notifications, prompts)
lib/           pure logic, no React (event classification, diff parsing, formatting)
```

Dependencies flow one way: `App.tsx → screens → components → hooks → lib`. Put
anything testable without a DOM in `lib/`, where it gets a unit test next to it
(`lib/diff.test.ts` and friends).

The DOM-level tests are integration tests against the whole app, grouped by
surface — `App.shell.test.tsx`, `App.taskCreation.test.tsx`,
`App.taskDetail.test.tsx` — and they share `test/appHarness.tsx`, which owns the
fetch mock standing in for the API, the `fixtures` object a test seeds, and
`renderApp()`. A new integration test goes in the suite for its surface and
seeds `fixtures`; it should not build its own fetch mock.

`App.tsx` still owns the selection state and the mutations, so a component it
renders takes what it needs as props — `components/TaskDetailPanel.tsx` is the
clearest case, and its props type is that dependency surface written down.
Pushing that state into the components that use it is worthwhile, but it changes
when state resets, so it is not a mechanical change.

Server state is TanStack Query. `useTaskStream` keeps a task's caches live over
SSE while it is open, so most components should read from the query cache rather
than fetching again.

## Shared types

`packages/shared/src/index.ts` mirrors `services/api/app/schemas.py` **by hand**.
There is no code generation. Changing a request/response shape means editing
both files in the same change.

## Commands

```bash
pnpm dev                    # web + api locally (127.0.0.1:5173 / :8000)
pnpm dev:external           # bind 0.0.0.0 for phone/Tailscale access (15173 / 18000)
pnpm test                   # shared + web (vitest) + api (pytest)
pnpm lint                   # tsc --noEmit for shared + web
pnpm build

pnpm --filter web test      # web only
.venv/bin/pytest services/api/tests -q   # api only, from the repo root
```

The Python venv is at the repo root (`.venv`), not inside `services/api`.
Install it with `python3 -m venv .venv && .venv/bin/pip install -e 'services/api[dev]'`.

## Gotchas

**The production database is a real file next to the code.** `dev-api.sh` runs
uvicorn with cwd `services/api`, so the default `sqlite:///./zenbar.db` resolves
to `services/api/zenbar.db` with real user data in it. `tests/conftest.py`
therefore *overwrites* `ZENBAR_DATABASE_URL`, `ZENBAR_RUNTIME_MODE` and the auth
env vars unconditionally rather than using `setdefault` — a developer shell that
exports the real values would otherwise point the whole test suite, including
fixtures that `DELETE FROM tasks`, at production. Do not weaken that back to
`setdefault`, and be careful with any script that opens the database directly.

**Import-time side effects.** `app/__init__.py` does `from .main import app`, so
importing anything from `app` constructs the runtime adapters and locks in
`db.py`'s module-level `DATABASE_URL`. Env vars must be set before the first
`app` import, which is why `conftest.py` sets them at the top.

**Engines are per task.** `ZENBAR_RUNTIME_MODE` only picks the *default* engine;
`create_engine_adapters()` builds all of them, and a task's `engine` column
decides which adapter serves it. A task stored with `""` for engine means "the
default engine" — use `or`, not `??`/`or None`, when reading it.

**Auth.** With `ZENBAR_API_TOKEN` set, every route requires it (header
`X-Zenbar-Token`, bearer, or `?token=`). With no token, only loopback clients are
allowed unless `ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE=true`. Remote access is
expected to be over Tailscale, and `ZENBAR_CORS_ORIGINS` must list the Tailscale
origin for the phone UI to work.

**Workspaces are real git worktrees** under `ZENBAR_WORKSPACE_ROOT`, branch
`task/<slug>-<shortid>`. Deleting a task must go through
`workspace.cleanup_workspace()` so the worktree is deregistered from the parent
repo, not just removed.

## Conventions

- Comments explain *why*, especially when the code encodes a bug that was
  actually hit; the existing ones are worth preserving verbatim when moving code.
- User-facing strings in the web UI are Korean; code, identifiers and comments
  are English.
- New API endpoints go in the router for their resource, with the request/response
  models in `schemas.py` and the TS mirror in `packages/shared`.
- New backend test files: `tests/conftest.py` runs first regardless of file name,
  so env safety is handled — but never add a test that writes to a database path
  it did not create.
