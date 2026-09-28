"""Creates and removes a task's isolated workspace.

Each task gets its own git branch or worktree (ZENBAR_WORKSPACE_ROOT) named
`task/<slug>-<shortid>`, so an agent can modify files freely without touching
the developer's checkout until the result is approved.
"""

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


def _nested_symlink_component(path: Path) -> Path | None:
    """Mirrors Codex's own writable-root rule (sandboxing/src/seatbelt.rs).

    Codex resolves top-level system aliases such as `/tmp -> /private/tmp` but
    rejects a symlink anywhere below that, because a deeper component can be
    swapped by an already-running sandboxed process -- following it would turn
    a path check into a new authority grant.
    """
    for ancestor in [path, *path.parents]:
        # A direct child of `/` is the top-level alias Codex still resolves.
        if ancestor.parent == ancestor or ancestor.parent.parent == ancestor.parent:
            continue
        if ancestor.is_symlink():
            return ancestor
    return None


def _assert_sandbox_safe_root(root: Path) -> None:
    """Fails loudly on a workspace root Codex's sandbox would refuse.

    Without this the misconfiguration is nearly invisible: the API, the task
    and the containers all stay healthy, the task sits in `running`, and the
    timeline shows only "Runtime is still running (no new output yet)"
    heartbeats while every `exec_command` and `apply_patch` fails inside the
    runtime. Only the App Server's own log names the reason. Refusing at task
    start turns that silent stall into one readable error.
    """
    symlink = _nested_symlink_component(root)
    if symlink is None:
        return
    raise RuntimeError(
        f"Workspace root {root} contains symlink component {symlink}; Codex's sandbox "
        "rejects symlinked writable roots. Point ZENBAR_WORKSPACE_ROOT at a real path."
    )


def _branch_exists(repo: Path, branch: str) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
        cwd=str(repo),
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _is_worktree_for_branch(workspace_path: Path, branch: str) -> bool:
    if not (workspace_path / ".git").exists():
        return False
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=str(workspace_path),
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == branch


def prepare_workspace(repo_path: str, default_branch: str, workspace_type: str, workspace_ref: str) -> PreparedWorkspace:
    repo = Path(repo_path).expanduser().resolve()
    if not (repo / ".git").exists():
        raise RuntimeError(f"Repository path is not a git repository: {repo}")

    root = _workspace_root()
    _assert_sandbox_safe_root(root)
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
        if _is_worktree_for_branch(workspace_path, workspace_ref):
            # Re-preparing a workspace that is still on disk used to delete it
            # and start the branch over from base_ref, throwing away whatever
            # the agent had not committed. A task reaches here whenever its
            # stored workspace_path no longer resolves -- after ZENBAR_
            # WORKSPACE_ROOT changes, say -- even though the worktree itself
            # is right where the new root says it should be.
            return PreparedWorkspace(str(workspace_path), workspace_ref, workspace_type)
        if workspace_path.exists():
            shutil.rmtree(workspace_path)
        # A directory that is gone leaves its worktree registration behind, and
        # git refuses to reuse the branch while that registration stands.
        # --expire=now overrides the gc.worktreePruneExpire grace period, which
        # otherwise keeps a just-deleted worktree's registration for months.
        _run_git(["worktree", "prune", "--expire=now"], str(repo))
        if _branch_exists(repo, workspace_ref):
            # The branch outliving its worktree is the normal state for any
            # task being restarted, so attaching to it is what keeps the task's
            # own history. `-b` would fail outright ("a branch named ...
            # already exists") and leave the task unable to retry at all.
            _run_git(["worktree", "add", str(workspace_path), workspace_ref], str(repo))
        else:
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
