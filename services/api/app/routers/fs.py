"""Directory browsing behind the web UI's repo-path picker."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..schemas import FsBrowseEntry, FsBrowseResponse

router = APIRouter()


@router.get("/fs/browse", response_model=FsBrowseResponse)
def get_fs_browse(path: str | None = None):
    from pathlib import Path

    browse_path = Path(path).expanduser().resolve() if path else Path.home()
    if not browse_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    try:
        entries = sorted(
            [
                FsBrowseEntry(name=entry.name, path=str(entry))
                for entry in browse_path.iterdir()
                if entry.is_dir() and not entry.name.startswith(".")
            ],
            key=lambda e: e.name.lower(),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    parent = str(browse_path.parent) if browse_path != browse_path.parent else None
    return FsBrowseResponse(path=str(browse_path), parent=parent, entries=entries)
