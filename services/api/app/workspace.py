from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


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

    _run_git(["fetch", "--all", "--prune"], str(repo))

    if workspace_type == "worktree":
        if workspace_path.exists():
            shutil.rmtree(workspace_path)
        _run_git(["worktree", "add", "-b", workspace_ref, str(workspace_path), default_branch], str(repo))
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
    _run_git(["checkout", default_branch], str(workspace_path))
    _run_git(["checkout", "-b", workspace_ref], str(workspace_path))
    return PreparedWorkspace(str(workspace_path), workspace_ref, workspace_type)
