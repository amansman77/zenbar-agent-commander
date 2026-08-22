from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# app/__init__.py does `from .main import app`, which eagerly constructs the
# TaskOrchestrator singleton (and therefore a real runtime adapter, e.g. one
# that opens a real websocket to a Codex App Server) AND app/db.py's
# module-level `DATABASE_URL` the moment anything is first imported from the
# `app` package. conftest.py is always loaded before any test file is
# collected, regardless of file name/alphabetical order, so setting these
# here — rather than relying on test_api.py's own top-of-file lines running
# first, which silently stops being true the moment some other test file
# sorts earlier in collection order — is what actually guarantees every test
# in the session gets the mock adapter and the test database.
#
# These are assigned unconditionally, NOT with setdefault: a developer's
# shell very often already exports the real ZENBAR_DATABASE_URL (the dev
# scripts source .env.local, and `sqlite:///./zenbar.db` resolves relative to
# the process cwd), and setdefault would then hand the whole test session the
# *production* database. That is not hypothetical — a test fixture doing a
# raw `DELETE FROM tasks` / `DELETE FROM projects` once wiped real user data
# exactly this way. A test run has no legitimate reason to honor an inherited
# database URL or runtime mode, so it always overrides them.
os.environ["ZENBAR_RUNTIME_MODE"] = "mock"
os.environ["ZENBAR_DATABASE_URL"] = f"sqlite:///{Path(__file__).with_name('test_zenbar.db')}"

# Auth is off for tests. Without this, an exported ZENBAR_API_TOKEN in the
# developer's shell makes every request from TestClient a 401.
os.environ.pop("ZENBAR_API_TOKEN", None)
os.environ.pop("ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE", None)
