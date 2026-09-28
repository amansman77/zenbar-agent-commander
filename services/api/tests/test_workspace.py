import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app.workspace import cleanup_workspace, prepare_workspace


def init_repo(tmpdir: str) -> Path:
    repo = Path(tmpdir) / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Zenbar Test"], cwd=repo, check=True, capture_output=True)
    (repo / "README.md").write_text("hello\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True)
    return repo


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def test_prepare_workspace_worktree_shares_git_dir_with_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        prepared = prepare_workspace(str(repo), "main", "worktree", "task/worktree-flow")

        workspace_path = Path(prepared.workspace_path)
        assert workspace_path.exists()
        assert prepared.workspace_type == "worktree"
        # A worktree's .git is a *file* pointing back at the main repo's
        # .git/worktrees/<name> dir, not an independent .git directory. This
        # is exactly the structure Codex's own trust resolution walks to find
        # the shared repo root — it's what lets every task worktree under one
        # zenbar Project inherit a single Codex project trust entry instead
        # of accumulating one per task.
        dot_git = workspace_path / ".git"
        assert dot_git.is_file()
        gitdir_line = dot_git.read_text().strip()
        assert gitdir_line.startswith("gitdir:")
        assert "worktrees" in gitdir_line

        # The new branch should be checked out and based on the repo's content.
        branch = _git(workspace_path, "rev-parse", "--abbrev-ref", "HEAD")
        assert branch == "task/worktree-flow"
        assert (workspace_path / "README.md").read_text() == "hello\n"

        # The main repo should list this worktree.
        listing = _git(repo, "worktree", "list")
        assert str(workspace_path) in listing


def test_cleanup_workspace_worktree_removes_dir_and_deregisters_from_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        prepared = prepare_workspace(str(repo), "main", "worktree", "task/worktree-cleanup")
        workspace_path = Path(prepared.workspace_path)
        assert workspace_path.exists()

        cleanup_workspace(prepared.workspace_path, "worktree", str(repo))

        assert not workspace_path.exists()
        listing = _git(repo, "worktree", "list")
        assert str(workspace_path) not in listing


def test_cleanup_workspace_branch_removes_standalone_clone(tmp_path, monkeypatch):
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        prepared = prepare_workspace(str(repo), "main", "branch", "task/branch-cleanup")
        workspace_path = Path(prepared.workspace_path)
        assert workspace_path.exists()
        # A "branch" workspace is a full standalone clone with its own .git dir.
        assert (workspace_path / ".git").is_dir()

        cleanup_workspace(prepared.workspace_path, "branch", str(repo))

        assert not workspace_path.exists()


def test_multiple_worktrees_for_same_repo_coexist(tmp_path, monkeypatch):
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        first = prepare_workspace(str(repo), "main", "worktree", "task/first")
        second = prepare_workspace(str(repo), "main", "worktree", "task/second")

        assert Path(first.workspace_path).exists()
        assert Path(second.workspace_path).exists()
        assert first.workspace_path != second.workspace_path

        listing = _git(repo, "worktree", "list")
        assert first.workspace_path in listing
        assert second.workspace_path in listing

        cleanup_workspace(first.workspace_path, "worktree", str(repo))
        cleanup_workspace(second.workspace_path, "worktree", str(repo))


def test_prepare_workspace_rejects_symlinked_root(tmp_path, monkeypatch):
    # Codex's sandbox refuses a writable root with a symlink component, and it
    # does so per tool call -- the task itself stays "running" and only emits
    # heartbeats. Failing at prepare time is what makes the cause visible.
    real_root = tmp_path / "real-workspaces"
    real_root.mkdir()
    linked_root = tmp_path / "linked-workspaces"
    linked_root.symlink_to(real_root, target_is_directory=True)
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(linked_root))

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        with pytest.raises(RuntimeError) as excinfo:
            prepare_workspace(str(repo), "main", "worktree", "task/symlinked-root")

    message = str(excinfo.value)
    assert str(linked_root) in message
    assert "ZENBAR_WORKSPACE_ROOT" in message


def test_prepare_workspace_allows_top_level_alias_root(tmp_path, monkeypatch):
    # `/tmp -> /private/tmp` is the alias Codex still resolves, so a root whose
    # only symlink is that top-level entry has to keep working.
    root = Path("/tmp") / f"zenbar-test-workspaces-{os.getpid()}"
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(root))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        try:
            prepared = prepare_workspace(str(repo), "main", "worktree", "task/alias-root")
            assert Path(prepared.workspace_path).exists()
        finally:
            shutil.rmtree(root, ignore_errors=True)


def test_prepare_workspace_reattaches_to_an_existing_branch(tmp_path, monkeypatch):
    # A restarted task re-prepares its workspace, and its branch is still
    # there from the first run. `worktree add -b` fails on that ("a branch
    # named ... already exists"), which used to leave the task unable to
    # retry at all -- the branch had to be deleted by hand.
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        first = prepare_workspace(str(repo), "main", "worktree", "task/reattach")
        workspace = Path(first.workspace_path)
        (workspace / "agent-work.txt").write_text("committed on the branch\n")
        _git(workspace, "add", "agent-work.txt")
        _git(workspace, "commit", "-m", "agent work")
        head = _git(workspace, "rev-parse", "HEAD")

        # The worktree is gone but the branch (and its commit) is not.
        shutil.rmtree(workspace)

        again = prepare_workspace(str(repo), "main", "worktree", "task/reattach")

        reattached = Path(again.workspace_path)
        assert _git(reattached, "rev-parse", "HEAD") == head
        assert (reattached / "agent-work.txt").exists()


def test_prepare_workspace_keeps_an_existing_worktree_and_its_uncommitted_work(tmp_path, monkeypatch):
    # Re-preparing a workspace that is still on disk used to rmtree it and
    # restart the branch from base, discarding everything uncommitted. This
    # happens for real whenever the stored workspace_path stops resolving --
    # a changed ZENBAR_WORKSPACE_ROOT -- while the worktree itself is fine.
    monkeypatch.setenv("ZENBAR_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        first = prepare_workspace(str(repo), "main", "worktree", "task/keep-work")
        workspace = Path(first.workspace_path)
        (workspace / "in-progress.txt").write_text("not committed yet\n")

        again = prepare_workspace(str(repo), "main", "worktree", "task/keep-work")

        assert again.workspace_path == first.workspace_path
        assert (Path(again.workspace_path) / "in-progress.txt").read_text() == "not committed yet\n"
