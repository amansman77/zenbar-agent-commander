from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# app/__init__.py does `from .main import app`, which eagerly constructs the
# TaskOrchestrator singleton (and therefore a real runtime adapter, e.g. one
# that opens a real websocket to a Codex App Server) the moment anything is
# first imported from the `app` package. conftest.py is always loaded before
# any test file is collected, regardless of file name/alphabetical order, so
# setting this here — rather than relying on each test file to do it before
# its own first `app`-package import — is what actually guarantees every test
# in the session gets the mock adapter.
os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")
