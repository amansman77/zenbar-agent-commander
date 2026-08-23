"""Deriving a task's slug and its workspace branch name from its title."""

from __future__ import annotations

import re

from uuid import uuid4


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "task"


def build_workspace_ref(title: str, project_name: str | None = None) -> str:
    # The branch name doubles as the workspace folder name (see
    # workspace.prepare_workspace: `workspace_ref.replace("/", "__")`), which
    # is also what shows up as the session/"project" label in the Codex app's
    # own UI. Prefixing with the zenbar Project's name instead of the generic
    # "task" makes it possible to tell, at a glance in that UI, which zenbar
    # project a session belongs to.
    prefix = slugify(project_name) if project_name else "task"
    return f"{prefix}/{slugify(title)}-{str(uuid4())[:4]}"
