"""Maintains Codex's `projects` trust table in ~/.codex/config.toml.

A repo path must be trusted for Codex to run in it without prompting, so a
project is trusted once at creation and every task worktree under it inherits
that trust.
"""

from __future__ import annotations

from pathlib import Path

import tomlkit

from .codex_profiles import codex_home


def _config_path() -> Path:
    return codex_home() / "config.toml"


def remove_project_trust_entry(workspace_path: str | None) -> bool:
    """Remove the `[projects."<workspace_path>"]` trust entry (if any) for the
    given path from ~/.codex/config.toml.

    Codex auto-registers a `[projects."<cwd>"]` trust entry the first time a
    session runs in a directory. zenbar workspace directories are deleted on
    task/conversation deletion (see workspace.cleanup_workspace), which would
    otherwise leave a stale, unusable entry behind indefinitely. This is called
    from cleanup_workspace so the two stay in sync automatically.

    Best-effort: any failure (missing file, unreadable/invalid TOML, missing
    projects table) is swallowed and reported as "nothing removed" rather than
    raised, since this must never block the actual workspace/task deletion it
    is attached to.

    Returns True if an entry was found and removed.
    """
    if not workspace_path:
        return False
    config_path = _config_path()
    if not config_path.exists():
        return False

    candidates = {workspace_path}
    try:
        candidates.add(str(Path(workspace_path).expanduser()))
    except (OSError, RuntimeError):
        pass

    try:
        doc = tomlkit.parse(config_path.read_text())
        projects = doc.get("projects")
        if projects is None:
            return False
        removed = False
        for key in list(projects.keys()):
            if key in candidates:
                del projects[key]
                removed = True
        if removed:
            config_path.write_text(tomlkit.dumps(doc))
        return removed
    except Exception:
        return False


def add_project_trust_entry(repo_path: str | None, trust_level: str = "trusted") -> bool:
    """Register `[projects."<repo_path>"]` with the given trust_level in
    ~/.codex/config.toml, if it isn't already present under this exact path.

    zenbar task workspaces are git worktrees of a Project's repo_path (see
    workspace.prepare_workspace), and Codex's own trust resolution walks a
    worktree's `.git` file back to the *main* repo root when deciding whether
    a cwd is trusted (it does not require a separate trust entry for every
    worktree). Pre-trusting repo_path here — once, when the zenbar Project is
    created — means every task/session created under it is automatically
    trusted too, instead of Codex auto-registering (and zenbar having to
    later clean up) one trust entry per task workspace.

    Best-effort: any failure is swallowed rather than raised, since this must
    never block zenbar project creation. Returns True if a new entry was
    written, False if one already existed (any trust_level) or on failure.
    """
    if not repo_path:
        return False
    config_path = _config_path()
    if not config_path.exists():
        return False

    try:
        resolved = str(Path(repo_path).expanduser())
    except (OSError, RuntimeError):
        resolved = repo_path

    try:
        doc = tomlkit.parse(config_path.read_text())
        projects = doc.get("projects")
        if projects is not None and (repo_path in projects or resolved in projects):
            return False
        if projects is None:
            projects = tomlkit.table()
            doc["projects"] = projects
        entry = tomlkit.table()
        entry["trust_level"] = trust_level
        projects[resolved] = entry
        config_path.write_text(tomlkit.dumps(doc))
        return True
    except Exception:
        return False


def remove_stale_project_trust_entries() -> list[str]:
    """Remove every `[projects."<path>"]` entry whose path no longer exists on
    disk. Used for one-off cleanup of entries that accumulated before this
    module existed (e.g. from deleted zenbar task workspaces). Returns the
    list of removed paths.
    """
    config_path = _config_path()
    if not config_path.exists():
        return []

    doc = tomlkit.parse(config_path.read_text())
    projects = doc.get("projects")
    if projects is None:
        return []

    removed: list[str] = []
    for key in list(projects.keys()):
        if not Path(key).expanduser().exists():
            del projects[key]
            removed.append(key)

    if removed:
        config_path.write_text(tomlkit.dumps(doc))
    return removed
