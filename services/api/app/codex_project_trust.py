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
