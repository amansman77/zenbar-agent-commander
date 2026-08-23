"""git operations on a task's workspace: commit, push, and reading its diff.

These were methods on TaskOrchestrator, but none of them ever touched the
orchestrator -- they only called each other. They are blocking subprocess
calls, which is why the orchestrator runs them through asyncio.to_thread.

Distinct from workspace.py, which creates and removes the worktree itself, and
from cli_adapter_git.py, which serves the CLI adapters.
"""

from __future__ import annotations

import os
import subprocess

from .models import Task
from .schemas import TaskDiff, TaskGitActionResponse


def _run_git(cwd: str, args: list[str]) -> str:
    completed = subprocess.run(
        ["git", "-C", cwd, *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _run_git_noquote(cwd: str, args: list[str]) -> str:
    """Like _run_git but with core.quotepath=false so non-ASCII paths are not octal-escaped."""
    completed = subprocess.run(
        ["git", "-C", cwd, "-c", "core.quotepath=false", *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def _run_git_full(cwd: str, args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", cwd, *args],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def _git_checked(cwd: str, args: list[str], env: dict[str, str] | None = None) -> str:
    completed = _run_git_full(cwd, args, env=env)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or f"git {' '.join(args)} failed"
        raise RuntimeError(message)
    return (completed.stdout.strip() or completed.stderr.strip()).strip()


def commit_workspace(workspace_path: str, message: str, actor: str) -> TaskGitActionResponse:
    _git_checked(workspace_path, ["rev-parse", "--is-inside-work-tree"])
    status = _git_checked(workspace_path, ["status", "--porcelain"])
    if not status:
        raise RuntimeError("No changes to commit in Task Workspace")

    _git_checked(workspace_path, ["add", "-A"])
    env = os.environ.copy()
    if actor.strip():
        name = actor.strip()
        email = os.getenv("ZENBAR_GIT_AUTHOR_EMAIL", "zenbar@local")
        env.setdefault("GIT_AUTHOR_NAME", name)
        env.setdefault("GIT_COMMITTER_NAME", name)
        env.setdefault("GIT_AUTHOR_EMAIL", email)
        env.setdefault("GIT_COMMITTER_EMAIL", email)
    commit_output = _git_checked(workspace_path, ["commit", "-m", message], env=env)
    branch = _git_checked(workspace_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    return TaskGitActionResponse(ok=True, branch=branch, message="Committed workspace changes", output=commit_output or None)


def push_workspace(workspace_path: str, remote: str, set_upstream: bool) -> TaskGitActionResponse:
    branch = _git_checked(workspace_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    args = ["push"]
    if set_upstream:
        args.append("-u")
    args.extend([remote, branch])
    push_output = _git_checked(workspace_path, args)
    return TaskGitActionResponse(
        ok=True,
        branch=branch,
        remote=remote,
        message="Pushed workspace branch",
        output=push_output or None,
    )


def compute_workspace_diff(task: Task) -> TaskDiff | None:
    workspace = task.workspace_path
    if not workspace:
        return None

    try:
        _run_git(workspace, ["rev-parse", "--is-inside-work-tree"])
    except Exception:
        return None

    files: list[str] = []
    raw_candidates: list[str] = []
    default_branch = task.project.default_branch if task.project else "main"

    def add_files(lines: str) -> None:
        for line in lines.splitlines():
            value = line.strip()
            if value:
                files.append(value)

    # Show only uncommitted changes: staged + unstaged (not vs base branch).
    # After a commit the diff will be empty — matching user expectation.
    name_only_cmds = [
        ["diff", "--cached", "--name-only"],
        ["diff", "--name-only"],
    ]
    for args in name_only_cmds:
        try:
            output = _run_git_noquote(workspace, args)
            if output:
                add_files(output)
        except Exception:
            continue

    raw_priority = [
        ["diff", "--cached"],
        ["diff"],
    ]
    for args in raw_priority:
        try:
            output = _run_git_noquote(workspace, args)
            if output and output.strip():
                raw_candidates.append(output)
        except Exception:
            continue

    # Generate diffs for untracked (new) files via --no-index
    # Use core.quotepath=false so non-ASCII (Korean) paths are not octal-escaped.
    # git diff --no-index always exits 1 when files differ, so use check=False.
    untracked_diffs: list[str] = []
    try:
        untracked_out = subprocess.run(
            ["git", "-C", workspace, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        for rel_path in (untracked_out or "").splitlines():
            rel_path = rel_path.strip()
            if not rel_path:
                continue
            files.append(rel_path)
            result = subprocess.run(
                ["git", "-C", workspace, "-c", "core.quotepath=false", "diff", "--no-index", "/dev/null", rel_path],
                check=False, capture_output=True, text=True,
            )
            # exit 0 = identical (shouldn't happen vs /dev/null), 1 = differs (normal), 2+ = error
            if result.returncode <= 1 and result.stdout.strip():
                untracked_diffs.append(result.stdout.strip())
    except Exception:
        pass

    deduped_files = list(dict.fromkeys(files))
    base_diff = raw_candidates[0] if raw_candidates else ""
    combined = "\n".join(filter(None, [base_diff] + untracked_diffs))
    raw_diff = combined.strip() or None
    if not deduped_files and not raw_diff:
        return None
    summary = f"Updated {len(deduped_files)} file(s) in the Task Workspace."
    return TaskDiff(files_changed=deduped_files, summary=summary, raw_diff=raw_diff)
