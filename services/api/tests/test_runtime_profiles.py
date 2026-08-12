from pathlib import Path

from app.runtime import AppServerWebSocketAdapter
from app.schemas import RuntimeStartRequest


def _request(**overrides) -> RuntimeStartRequest:
    defaults = dict(
        task_id="task-1",
        title="Test task",
        prompt="Do work",
        model="gpt-explicit",
        repo_path="/srv/repos/demo",
        working_directory="/srv/repos/demo",
        default_branch="main",
        workspace_type="branch",
        workspace_ref="task/test-a1b2",
    )
    defaults.update(overrides)
    return RuntimeStartRequest(**defaults)


def test_profile_model_wins_over_an_explicit_model_at_thread_start(tmp_path: Path, monkeypatch):
    (tmp_path / "careful.config.toml").write_text(
        'model = "gpt-from-profile"\napproval_policy = "untrusted"\nsandbox_mode = "read-only"\n'
    )
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    params = adapter._build_turn_start_params(
        "thread-1", _request(model="gpt-explicit", profile="careful")
    )

    assert params["model"] == "gpt-from-profile"
    assert params["approvalPolicy"] == "untrusted"
    assert params["sandboxPolicy"]["type"] == "readOnly"


def test_explicit_model_used_when_profile_has_no_model(tmp_path: Path, monkeypatch):
    (tmp_path / "sandboxed.config.toml").write_text('sandbox_mode = "read-only"\n')
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    params = adapter._build_turn_start_params(
        "thread-1", _request(model="gpt-explicit", profile="sandboxed")
    )

    assert "model" not in params
    assert params["sandboxPolicy"]["type"] == "readOnly"


def test_no_profile_leaves_turn_start_params_unchanged(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    params = adapter._build_turn_start_params("thread-1", _request(model="gpt-explicit", profile=None))

    assert "model" not in params
    assert params["approvalPolicy"] == "on-request"
    assert params["sandboxPolicy"]["type"] == "workspaceWrite"
