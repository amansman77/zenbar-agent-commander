"""Reads Codex CLI profiles (model + provider presets) from CODEX_HOME.

Profiles are defined outside Zenbar by the Codex CLI itself; a task can select
one, and a profile's own model takes precedence over the engine model catalog.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python <3.11 fallback
    import tomli as tomllib  # type: ignore[no-redef]


# Codex CLI "profiles" (`-p/--profile <name>`) are `$CODEX_HOME/<name>.config.toml`
# files layered on top of the base `config.toml`. We read them the same way Codex
# CLI does so the profiles a user already maintains locally just work here too.
_PROFILE_SUFFIX = ".config.toml"


@dataclass
class RuntimeProfile:
    id: str
    model: str | None = None
    model_provider: str | None = None
    reasoning_effort: str | None = None
    approval_policy: str | None = None
    sandbox_mode: str | None = None
    personality: str | None = None
    # The profile's [sandbox_workspace_write] table, the same keys Codex CLI
    # reads. Zenbar sends an explicit sandboxPolicy on every turn, which
    # replaces whatever the App Server's own config says, so these only take
    # effect because the adapter copies them into that policy.
    network_access: bool | None = None
    writable_roots: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def description(self) -> str | None:
        parts: list[str] = []
        if self.model:
            parts.append(self.model)
        if self.approval_policy:
            parts.append(f"approval={self.approval_policy}")
        if self.sandbox_mode:
            parts.append(f"sandbox={self.sandbox_mode}")
        return ", ".join(parts) if parts else None


def codex_home() -> Path:
    configured = os.getenv("CODEX_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".codex"


def _parse_profile_file(path: Path) -> RuntimeProfile | None:
    try:
        raw = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return None
    profile_id = path.name[: -len(_PROFILE_SUFFIX)]
    if not profile_id:
        return None
    workspace_write = raw.get("sandbox_workspace_write")
    if not isinstance(workspace_write, dict):
        workspace_write = {}
    network_access = workspace_write.get("network_access")
    writable_roots = workspace_write.get("writable_roots")
    return RuntimeProfile(
        id=profile_id,
        model=raw.get("model") if isinstance(raw.get("model"), str) else None,
        model_provider=raw.get("model_provider") if isinstance(raw.get("model_provider"), str) else None,
        reasoning_effort=raw.get("model_reasoning_effort") if isinstance(raw.get("model_reasoning_effort"), str) else None,
        approval_policy=raw.get("approval_policy") if isinstance(raw.get("approval_policy"), str) else None,
        sandbox_mode=raw.get("sandbox_mode") if isinstance(raw.get("sandbox_mode"), str) else None,
        personality=raw.get("personality") if isinstance(raw.get("personality"), str) else None,
        network_access=network_access if isinstance(network_access, bool) else None,
        writable_roots=[r for r in writable_roots if isinstance(r, str)] if isinstance(writable_roots, list) else [],
        raw=raw,
    )


def list_profiles(home: Path | None = None) -> list[RuntimeProfile]:
    base = home or codex_home()
    if not base.is_dir():
        return []
    profiles: list[RuntimeProfile] = []
    for path in sorted(base.glob(f"*{_PROFILE_SUFFIX}")):
        profile = _parse_profile_file(path)
        if profile is not None:
            profiles.append(profile)
    return profiles


def get_profile(profile_id: str | None, home: Path | None = None) -> RuntimeProfile | None:
    if not profile_id:
        return None
    for profile in list_profiles(home):
        if profile.id == profile_id:
            return profile
    return None
