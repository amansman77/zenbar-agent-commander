import json
import os
import subprocess
from pathlib import Path

# app/__init__.py does `from .main import app`, which eagerly constructs the
# TaskOrchestrator singleton (and therefore a real runtime adapter) as soon as
# anything is imported from the `app` package. Set this before that first
# import — same as test_api.py — or whichever test file happens to be
# collected first silently pins the whole session to a real (non-mock)
# adapter for every test, including test_api.py's own.
os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.antigravity_adapter import (
    _diff_payload,
    _last_model_response,
    _max_step_index,
    _read_conversation_id_for_cwd,
)


def _write_transcript(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(item) for item in items) + "\n")


def test_last_model_response_filters_to_done_planner_response(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGY_HOME", str(tmp_path))
    conversation_id = "conv-1"
    transcript = tmp_path / "brain" / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"
    _write_transcript(
        transcript,
        [
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "content": "hi"},
            {"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "ACTIVE", "content": "partial"},
            {"step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": "final answer"},
            {"step_index": 3, "source": "SYSTEM", "type": "CHECKPOINT", "status": "DONE", "content": "unrelated"},
        ],
    )

    assert _last_model_response(conversation_id) == "final answer"
    # A later checkpoint with no matching MODEL/PLANNER_RESPONSE after min_step_index yields None.
    assert _last_model_response(conversation_id, min_step_index=2) is None


def test_last_model_response_missing_transcript_returns_none(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGY_HOME", str(tmp_path))
    assert _last_model_response("does-not-exist") is None


def test_max_step_index(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGY_HOME", str(tmp_path))
    conversation_id = "conv-2"
    transcript = tmp_path / "brain" / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"
    _write_transcript(transcript, [{"step_index": 0}, {"step_index": 5}, {"step_index": 2}])

    assert _max_step_index(conversation_id) == 5
    assert _max_step_index(None) == -1


def test_read_conversation_id_for_cwd(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGY_HOME", str(tmp_path))
    cache_file = tmp_path / "cache" / "last_conversations.json"
    cache_file.parent.mkdir(parents=True)
    cache_file.write_text(json.dumps({"/some/workspace": "conv-abc"}))

    assert _read_conversation_id_for_cwd("/some/workspace") == "conv-abc"
    assert _read_conversation_id_for_cwd("/other/workspace") is None


def test_read_conversation_id_missing_cache_file(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AGY_HOME", str(tmp_path))
    assert _read_conversation_id_for_cwd("/anything") is None


def _init_git_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Zenbar Test"], cwd=path, check=True, capture_output=True)
    (path / "math_utils.py").write_text("def add(a, b): return a + b\n")
    subprocess.run(["git", "add", "."], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


def test_diff_payload_reports_no_changes(tmp_path: Path):
    _init_git_repo(tmp_path)
    diff = _diff_payload(str(tmp_path), "main")
    assert diff.files_changed == []
    assert diff.raw_diff is None


def test_diff_payload_reports_real_changes(tmp_path: Path):
    _init_git_repo(tmp_path)
    (tmp_path / "math_utils.py").write_text("def add(a, b): return a + b\n\n\ndef subtract(a, b): return a - b\n")

    diff = _diff_payload(str(tmp_path), "main")

    assert diff.files_changed == ["math_utils.py"]
    assert "subtract" in (diff.raw_diff or "")
    assert "1 file(s)" in diff.summary
