import json
import os
from pathlib import Path

# app/__init__.py does `from .main import app`, which eagerly constructs the
# TaskOrchestrator singleton (and therefore a real runtime adapter) as soon as
# anything is imported from the `app` package. Set this before that first
# import — same as test_api.py — or whichever test file happens to be
# collected first silently pins the whole session to a real (non-mock)
# adapter for every test, including test_api.py's own.
os.environ.setdefault("ZENBAR_RUNTIME_MODE", "mock")

from app.antigravity_adapter import (
    _last_model_response,
    _max_step_index,
    _parse_agy_usage_output,
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


# Real shape from `agy -p "/usage" --output-format json`, captured live --
# confirmed a free/local status answer (num_turns: 0), grouped per model
# family since Antigravity meters Gemini and Claude/GPT-family models
# separately.
_AGY_USAGE_PAYLOAD = {
    "command": {
        "data": {
            "groups": [
                {
                    "name": "Gemini Models",
                    "buckets": [
                        {"window": "weekly", "remaining_fraction": 0.9993653893470764, "reset_time": "2026-08-27T01:34:22Z"},
                        {"window": "5h", "remaining_fraction": 1.0, "reset_time": "2026-08-21T05:15:59Z"},
                    ],
                },
                {
                    "name": "Claude and GPT models",
                    "buckets": [
                        {"window": "weekly", "remaining_fraction": 0.6, "reset_time": "2026-08-28T00:15:59Z"},
                        {"window": "5h", "remaining_fraction": 1.0, "reset_time": "2026-08-21T05:15:59Z"},
                    ],
                },
            ]
        }
    }
}


def test_parse_agy_usage_output_picks_the_worst_group_per_window():
    # Claude/GPT's weekly bucket (40% used) is worse than Gemini's (0%), so
    # it should win for "week"; both 5h buckets are equally fresh (0% used)
    # so either could technically win -- just confirm it comes back 0%.
    usage = _parse_agy_usage_output(json.dumps(_AGY_USAGE_PAYLOAD))

    assert usage is not None
    assert usage.week is not None
    assert usage.week.percent_used == 40
    assert usage.week.resets_label is not None
    assert "Claude and GPT models" in usage.week.resets_label
    # reset_time is already ISO 8601 from the CLI's own JSON -- passed
    # through as resets_at (unmodified, unlike the label) so the frontend
    # can compute its own countdown.
    assert usage.week.resets_at == "2026-08-28T00:15:59Z"
    assert usage.session is not None
    assert usage.session.percent_used == 0


def test_parse_agy_usage_output_returns_none_for_unrecognized_json():
    assert _parse_agy_usage_output(json.dumps({"unrelated": True})) is None


def test_parse_agy_usage_output_returns_none_for_non_json():
    assert _parse_agy_usage_output("not json at all") is None
