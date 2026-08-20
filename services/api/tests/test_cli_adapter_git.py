import os
import subprocess
from pathlib import Path

os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.cli_adapter_git import compute_workspace_diff


def _init_git_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Zenbar Test"], cwd=path, check=True, capture_output=True)
    (path / "math_utils.py").write_text("def add(a, b): return a + b\n")
    subprocess.run(["git", "add", "."], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


def test_compute_workspace_diff_reports_no_changes(tmp_path: Path):
    _init_git_repo(tmp_path)
    diff = compute_workspace_diff(str(tmp_path), "main", "Antigravity")
    assert diff.files_changed == []
    assert diff.raw_diff is None


def test_compute_workspace_diff_reports_real_changes(tmp_path: Path):
    _init_git_repo(tmp_path)
    (tmp_path / "math_utils.py").write_text("def add(a, b): return a + b\n\n\ndef subtract(a, b): return a - b\n")

    diff = compute_workspace_diff(str(tmp_path), "main", "Antigravity")

    assert diff.files_changed == ["math_utils.py"]
    assert "subtract" in (diff.raw_diff or "")
    assert "1 file(s)" in diff.summary


def test_compute_workspace_diff_works_for_a_different_caller_engine(tmp_path: Path):
    # Shared by AntigravityCliAdapter and GrokCliAdapter (see cli_adapter_git.py's
    # docstring) -- confirm it works identically for a second caller, not just
    # the one it happened to be extracted from.
    _init_git_repo(tmp_path)
    (tmp_path / "math_utils.py").write_text("def add(a, b): return a + b\n\n\ndef subtract(a, b): return a - b\n")

    diff = compute_workspace_diff(str(tmp_path), "main", "Grok")

    assert diff.files_changed == ["math_utils.py"]
    assert "subtract" in (diff.raw_diff or "")


def test_compute_workspace_diff_missing_workspace_returns_empty():
    diff = compute_workspace_diff("/nonexistent-path-zzz", "main", "Grok")
    assert diff.files_changed == []
    assert diff.raw_diff is None


def test_compute_workspace_diff_includes_new_untracked_files(tmp_path: Path):
    # Regression: `git diff <ref>` never reports untracked files no matter
    # what ref it's compared against -- a file the agent just created (and
    # never `git add`ed) was invisible here, silently reporting an empty
    # diff for a task that had genuinely produced output. Found by running a
    # real Grok turn end-to-end, not by reasoning about the code.
    _init_git_repo(tmp_path)
    (tmp_path / "new_file.txt").write_text("brand new, never staged\n")

    diff = compute_workspace_diff(str(tmp_path), "main", "Grok")

    assert diff.files_changed == ["new_file.txt"]
    assert "brand new, never staged" in (diff.raw_diff or "")
    assert "1 file(s)" in diff.summary


def test_compute_workspace_diff_combines_tracked_and_untracked_changes(tmp_path: Path):
    _init_git_repo(tmp_path)
    (tmp_path / "math_utils.py").write_text("def add(a, b): return a + b\n\n\ndef subtract(a, b): return a - b\n")
    (tmp_path / "new_file.txt").write_text("also new\n")

    diff = compute_workspace_diff(str(tmp_path), "main", "Grok")

    assert sorted(diff.files_changed) == ["math_utils.py", "new_file.txt"]
    assert "subtract" in (diff.raw_diff or "")
    assert "also new" in (diff.raw_diff or "")
