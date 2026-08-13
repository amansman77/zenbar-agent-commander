from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .codex_project_trust import remove_project_trust_entry


@dataclass
class PreparedWorkspace:
    workspace_path: str
    workspace_ref: str
    workspace_type: str


def _run_git(args: list[str], cwd: str) -> None:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"git {' '.join(args)} failed")


def _run_git_output(args: list[str], cwd: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def _workspace_root() -> Path:
    configured = os.getenv("ZENBAR_WORKSPACE_ROOT")
    if configured:
        return Path(configured).expanduser()
    return Path(os.getenv("TMPDIR", "/tmp")) / "zenbar-task-workspaces"


def prepare_workspace(repo_path: str, default_branch: str, workspace_type: str, workspace_ref: str) -> PreparedWorkspace:
    repo = Path(repo_path).expanduser().resolve()
    if not (repo / ".git").exists():
        raise RuntimeError(f"Repository path is not a git repository: {repo}")

    root = _workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    workspace_path = root / workspace_ref.replace("/", "__")

    try:
        _run_git(["fetch", "--all", "--prune"], str(repo))
    except RuntimeError:
        pass

    # Determine the best base ref: prefer origin/default_branch (latest remote),
    # fall back to local default_branch if remote tracking ref doesn't exist.
    def _resolve_remote_ref(branch: str) -> str:
        for ref in [f"origin/{branch}", branch]:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", ref],
                cwd=str(repo), capture_output=True, text=True,
            )
            if result.returncode == 0:
                return ref
        return branch

    base_ref = _resolve_remote_ref(default_branch)

    if workspace_type == "worktree":
        if workspace_path.exists():
            shutil.rmtree(workspace_path)
        _run_git(["worktree", "add", "-b", workspace_ref, str(workspace_path), base_ref], str(repo))
        return PreparedWorkspace(str(workspace_path), workspace_ref, workspace_type)

    if workspace_path.exists():
        shutil.rmtree(workspace_path)
    _run_git(["clone", str(repo), str(workspace_path)], str(root))
    try:
        upstream_origin = _run_git_output(["remote", "get-url", "origin"], str(repo))
    except RuntimeError:
        upstream_origin = ""
    if upstream_origin:
        _run_git(["remote", "set-url", "origin", upstream_origin], str(workspace_path))
        _run_git(["remote", "set-url", "--push", "origin", upstream_origin], str(workspace_path))
        try:
            _run_git(["fetch", "origin"], str(workspace_path))
            _run_git(["checkout", default_branch], str(workspace_path))
            _run_git(["reset", "--hard", f"origin/{default_branch}"], str(workspace_path))
        except RuntimeError:
            _run_git(["checkout", default_branch], str(workspace_path))
    else:
        _run_git(["checkout", default_branch], str(workspace_path))
    _run_git(["checkout", "-b", workspace_ref], str(workspace_path))
    return PreparedWorkspace(str(workspace_path), workspace_ref, workspace_type)


def cleanup_workspace(workspace_path: str | None, workspace_type: str | None, repo_path: str | None) -> None:
    if not workspace_path:
        return
    path = Path(workspace_path)
    if path.exists():
        if workspace_type == "worktree" and repo_path:
            repo = Path(repo_path).expanduser().resolve()
            try:
                _run_git(["worktree", "remove", "--force", str(path)], str(repo))
            except RuntimeError:
                pass
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
    try:
        remove_project_trust_entry(workspace_path)
    except Exception:
        # Never let Codex trust-file bookkeeping block workspace cleanup.
        pass
