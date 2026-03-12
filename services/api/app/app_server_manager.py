from __future__ import annotations

import asyncio
import os
import shutil
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlparse

import httpx


class ManagedAppServer:
    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        if os.getenv("ZENBAR_RUNTIME_MODE", "app_server_ws") == "mock":
            return
        if os.getenv("ZENBAR_APP_SERVER_MANAGED", "true").lower() not in {"1", "true", "yes"}:
            return
        if self._process is not None and self._process.returncode is None:
            return

        ws_url = os.getenv("ZENBAR_APP_SERVER_WS_URL", "ws://127.0.0.1:8765")
        parsed = urlparse(ws_url)
        ready_url = f"http://{parsed.hostname}:{parsed.port}/readyz"

        if await self._is_ready(ready_url):
            return

        command = self._resolve_command()
        self._process = await asyncio.create_subprocess_exec(
            command,
            "app-server",
            "--listen",
            ws_url,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(30):
            if await self._is_ready(ready_url):
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("Timed out waiting for managed Codex App Server to become ready")

    async def stop(self) -> None:
        if self._process is None or self._process.returncode is not None:
            return
        self._process.terminate()
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._process.wait(), timeout=5)
            return
        self._process.kill()
        await self._process.wait()

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
