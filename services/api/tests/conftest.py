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
# This isn't hypothetical: before this file set these, a new test file that
# sorted alphabetically before test_api.py caused a `DELETE FROM tasks` /
# `DELETE FROM projects` test fixture to run against the real production
# services/api/zenbar.db (because DATABASE_URL had already locked in its
# default of `sqlite:///./zenbar.db` before test_api.py's own env-setting
# line ever executed) and wiped real user data. See
# critical_never_run_pytest_from_services_api in project memory for the
# full incident writeup. Do not remove either setdefault below.
os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")
os.environ.setdefault("ZENBAR_DATABASE_URL", f"sqlite:///{Path(__file__).with_name('test_zenbar.db')}")
