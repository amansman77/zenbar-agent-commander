"""Supervises the Codex App Server child process.

Only used when ZENBAR_APP_SERVER_MANAGED is set; otherwise the App Server is
expected to already be running at ZENBAR_APP_SERVER_WS_URL. Started and stopped
from main.py's lifespan.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from contextlib import suppress
from pathlib import Path
from typing import IO
from urllib.parse import urlparse

import httpx


def _log_file_path() -> Path:
    configured = os.getenv("ZENBAR_APP_SERVER_LOG_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path(os.getenv("TMPDIR", "/tmp")) / "zenbar-app-server.log"


class ManagedAppServer:
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        # Kept open for the process's lifetime; closed in stop(). Was
        # DEVNULL before -- when several sessions on this App Server all
        # reported notLoaded within the same instant (see
        # runtime/app_server.py's thread/status/changed handling), there
        # was no way to tell whether the process itself had hiccuped,
        # since nothing it printed was ever kept.
        self._log_file: IO[bytes] | None = None

    async def start(self) -> None:
        if os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws") == "mock":
            return
        if os.getenv("ZENBAR_APP_SERVER_MANAGED", "true").lower() not in {"1", "true", "yes"}:
            return
        if self._process is not None and self._process.returncode is None:
            return

        ws_url = os.getenv("ZENBAR_APP_SERVER_WS_URL", "ws://127.0.0.1:18765")
        parsed = urlparse(ws_url)
        ready_url = f"http://{parsed.hostname}:{parsed.port}/readyz"

        if await self._is_ready(ready_url):
            return

        command = self._resolve_command()
        log_path = _log_file_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Truncated per start, matching how the dev scripts' own
        # `>"$log_file"` (not `>>`) resets each restart -- this is a
        # rolling diagnostic log, not a retained audit trail.
        self._log_file = open(log_path, "wb")
        self._process = await asyncio.create_subprocess_exec(
            command,
            "app-server",
            "--listen",
            ws_url,
            stdout=self._log_file,
            stderr=asyncio.subprocess.STDOUT,
        )
        for _ in range(30):
            if await self._is_ready(ready_url):
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("Timed out waiting for managed Codex App Server to become ready")

    async def stop(self) -> None:
        try:
            if self._process is None or self._process.returncode is not None:
                return
            self._process.terminate()
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._process.wait(), timeout=5)
                return
            self._process.kill()
            await self._process.wait()
        finally:
            if self._log_file is not None:
                self._log_file.close()
                self._log_file = None

    def _resolve_command(self) -> str:
        configured = os.getenv("ZENBAR_APP_SERVER_COMMAND")
        if configured:
            return configured

        discovered = shutil.which("codex")
        if discovered:
            return discovered

        macos_bundle = Path("/Applications/Codex.app/Contents/Resources/codex")
        if macos_bundle.exists():
            return str(macos_bundle)

        raise RuntimeError(
            "Could not find the Codex CLI executable. "
            "Set ZENBAR_APP_SERVER_COMMAND to the absolute path of codex."
        )

    async def _is_ready(self, ready_url: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                response = await client.get(ready_url)
                return response.status_code == 200
        except Exception:
            return False
