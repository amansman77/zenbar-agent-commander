"""Reading a TaskDiff out of the runtime's diff payloads.

The Codex App Server reports a turn's changes in several shapes depending on
the message (a raw unified diff string, a structured file list, or a nested
payload), so these normalize all of them to one TaskDiff.
"""

from __future__ import annotations

from typing import Any

from ..schemas import TaskDiff

def _extract_files_from_diff(diff: str) -> list[str]:
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                files.append(parts[3].removeprefix("b/"))
        elif line.startswith("+++ b/"):
            files.append(line.removeprefix("+++ b/"))
    return list(dict.fromkeys(files))


def _build_diff_payload(diff: str) -> TaskDiff:
    files = _extract_files_from_diff(diff)
    summary = f"Updated {len(files)} file(s) in the Task Workspace." if files else "Diff updated in Codex App Server."
    return TaskDiff(files_changed=files, summary=summary, raw_diff=diff)


def _coerce_diff_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        for key in ("unifiedDiff", "unified_diff", "diff", "patch", "rawDiff", "raw_diff"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ""


def _extract_changed_files(payload: dict[str, Any]) -> list[str]:
    files: list[str] = []

    def add_file(candidate: Any) -> None:
        if isinstance(candidate, str) and candidate.strip():
            files.append(candidate.strip())
            return
        if isinstance(candidate, dict):
            for key in ("path", "file", "filePath", "filepath", "newPath", "oldPath"):
                value = candidate.get(key)
                if isinstance(value, str) and value.strip():
                    files.append(value.strip())
                    return

    for key in ("files", "filePaths", "paths"):
        value = payload.get(key)
        if isinstance(value, list):
            for item in value:
                add_file(item)

    changes = payload.get("changes")
    if isinstance(changes, list):
        for item in changes:
            add_file(item)

    single_path = payload.get("path") or payload.get("filePath") or payload.get("file")
    add_file(single_path)
    return list(dict.fromkeys(files))


def _extract_diff_payload(payload: dict[str, Any]) -> TaskDiff | None:
    for key in ("diff", "unifiedDiff", "unified_diff", "patch", "rawDiff", "raw_diff"):
        diff_text = _coerce_diff_text(payload.get(key))
        if diff_text:
            return _build_diff_payload(diff_text)

    changes = payload.get("changes")
    if isinstance(changes, list):
        for item in changes:
            if isinstance(item, dict):
                for key in ("diff", "unifiedDiff", "unified_diff", "patch", "rawDiff", "raw_diff"):
                    diff_text = _coerce_diff_text(item.get(key))
                    if diff_text:
                        return _build_diff_payload(diff_text)

    files = _extract_changed_files(payload)
    if files:
        return TaskDiff(
            files_changed=files,
            summary=f"Updated {len(files)} file(s) in the Task Workspace.",
            raw_diff=None,
        )
    return None
