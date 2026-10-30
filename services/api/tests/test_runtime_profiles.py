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


def test_profile_sandbox_workspace_write_reaches_the_turn_sandbox_policy(tmp_path: Path, monkeypatch):
    # Zenbar sends an explicit sandboxPolicy on every turn, so the profile's
    # own [sandbox_workspace_write] would otherwise be silently ignored, and a
    # tool that needs the network (the sqlgen infra bot) fails in the sandbox.
    (tmp_path / "netted.config.toml").write_text(
        '[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/srv/shared-cache"]\n'
    )
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    adapter = AppServerWebSocketAdapter("ws://127.0.0.1:0")
    policy = adapter._build_turn_start_params("thread-1", _request(profile="netted"))["sandboxPolicy"]
    assert policy["type"] == "workspaceWrite"
    assert policy["networkAccess"] is True
    assert policy["writableRoots"] == ["/srv/repos/demo", "/srv/shared-cache"]

    plain = adapter._build_turn_start_params("thread-1", _request(profile=None))["sandboxPolicy"]
    assert plain["networkAccess"] is False
    assert plain["writableRoots"] == ["/srv/repos/demo"]


def test_codex_task_on_a_provider_with_its_own_app_server_is_routed_there(tmp_path: Path, monkeypatch):
    # Codex 0.166 only accepts input on a thread whose provider matches its
    # App Server's, so an azure profile has to reach the azure-pinned server.
    from app.models import Task
    from app.runtime import MockRuntimeAdapter
    from app.service import TaskOrchestrator

    (tmp_path / "azure-6.config.toml").write_text('model = "dep-6"\nmodel_provider = "azure"\n')
    (tmp_path / "other.config.toml").write_text('model = "x"\nmodel_provider = "somewhere"\n')
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    default_codex, azure_codex, claude = MockRuntimeAdapter(), MockRuntimeAdapter(), MockRuntimeAdapter()
    orchestrator = TaskOrchestrator(
        {"codex": default_codex, "claude": claude}, "codex", codex_provider_adapters={"azure": azure_codex}
    )

    def task(engine, profile):
        return Task(engine=engine, profile=profile)

    assert orchestrator._adapter_for(task("codex", "azure-6")) is azure_codex
    assert orchestrator._adapter_for(task("", "azure-6")) is azure_codex  # "" means the default engine
    assert orchestrator._adapter_for(task("codex", None)) is default_codex
    assert orchestrator._adapter_for(task("codex", "other")) is default_codex  # no server for that provider
    assert orchestrator._adapter_for(task("codex", "missing-profile")) is default_codex
    assert orchestrator._adapter_for(task("claude", "azure-6")) is claude


def test_provider_app_servers_are_read_from_the_environment(monkeypatch):
    from app.runtime import AppServerWebSocketAdapter, create_codex_provider_adapters

    monkeypatch.setenv("ZENBAR_RUNTIME_MODE", "app_server_ws")
    monkeypatch.setenv("ZENBAR_APP_SERVER_PROVIDER_URLS", " azure=ws://127.0.0.1:18766 , broken, =ws://x ")
    adapters = create_codex_provider_adapters()
    assert list(adapters) == ["azure"]
    assert isinstance(adapters["azure"], AppServerWebSocketAdapter)
    assert adapters["azure"]._url == "ws://127.0.0.1:18766"

    monkeypatch.delenv("ZENBAR_APP_SERVER_PROVIDER_URLS")
    assert create_codex_provider_adapters() == {}
