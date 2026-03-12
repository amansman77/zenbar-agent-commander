from __future__ import annotations

import platform
import subprocess
from pathlib import Path

from .schemas import DiscoverProjectResponse


class RepositoryDiscoveryError(RuntimeError):
    pass


class FolderSelectionCancelled(RepositoryDiscoveryError):
    pass


def choose_repository_path(requested_path: str | None = None) -> Path:
    if requested_path:
        return Path(requested_path).expanduser().resolve()
    return _choose_path_from_native_dialog()


def discover_repository(path: str | None = None) -> DiscoverProjectResponse:
    selected_path = choose_repository_path(path)
    if not selected_path.is_dir():
        raise RepositoryDiscoveryError("Selected path is not a directory")
    if not is_git_repository(selected_path):
        raise RepositoryDiscoveryError("Selected folder is not a git repository")

    current_branch = get_current_branch(selected_path)
    return DiscoverProjectResponse(
        name=selected_path.name,
        repo_path=str(selected_path),
        default_branch=get_default_branch(selected_path, current_branch),
        current_branch=current_branch,
        is_git_repo=True,
    )


def is_git_repository(path: Path) -> bool:
    try:
        _run_git(path, "rev-parse", "--is-inside-work-tree")
    except RepositoryDiscoveryError:
        return False
    return True


def get_default_branch(path: Path, current_branch: str | None) -> str:
    try:
        origin_head = _run_git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    except RepositoryDiscoveryError:
        origin_head = ""
    if origin_head.startswith("origin/"):
        return origin_head.removeprefix("origin/")
    return current_branch or "main"


def get_current_branch(path: Path) -> str | None:
    try:
        branch = _run_git(path, "branch", "--show-current")
    except RepositoryDiscoveryError:
        return None
    return branch or None


def _choose_path_from_native_dialog() -> Path:
    if platform.system() != "Darwin":
        raise RepositoryDiscoveryError("Native folder picker is currently supported only on macOS")

    script = 'POSIX path of (choose folder with prompt "Choose a repository folder for Web Commander")'
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RepositoryDiscoveryError("osascript is not available on this host") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        if "User canceled" in stderr or "(-128)" in stderr:
            raise FolderSelectionCancelled("Folder selection was cancelled") from exc
        raise RepositoryDiscoveryError(f"Native folder picker failed: {stderr or exc}") from exc

    return Path(result.stdout.strip()).expanduser().resolve()


def _run_git(path: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=path,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RepositoryDiscoveryError("git is not available on this host") from exc
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or exc.stdout or "").strip()
        raise RepositoryDiscoveryError(message or f"git {' '.join(args)} failed") from exc
    return result.stdout.strip()
