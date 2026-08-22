from __future__ import annotations

import asyncio
import contextlib
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
import pytest

os.environ["ZENBAR_RUNTIME_MODE"] = "mock"
os.environ["ZENBAR_DATABASE_URL"] = f"sqlite:///{Path(__file__).with_name('test_zenbar.db')}"

from app.db import Base, SessionLocal, engine, ensure_schema  # noqa: E402
from app.main import app  # noqa: E402
from app.repository import append_event, get_task  # noqa: E402
from app.schemas import RuntimeEvent  # noqa: E402
from app.streaming import broker  # noqa: E402

db_file = Path(__file__).with_name("test_zenbar.db")
if db_file.exists():
    db_file.unlink()
Base.metadata.create_all(bind=engine)

client = TestClient(app)

ACTIVE_STATUSES_FOR_TEST = {"queued", "starting", "running", "waiting_user_input", "waiting_result_approval"}


def init_repo(tmpdir: str) -> Path:
    repo = Path(tmpdir) / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Zenbar Test"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "receive.denyCurrentBranch", "updateInstead"], cwd=repo, check=True, capture_output=True)
    (repo / "README.md").write_text("hello\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True)
    return repo


def init_repo_with_remote(tmpdir: str) -> Path:
    repo, _ = init_repo_with_remote_paths(tmpdir)
    return repo


def init_repo_with_remote_paths(tmpdir: str) -> tuple[Path, Path]:
    bare = Path(tmpdir) / "remote.git"
    subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
    repo = init_repo(tmpdir)
    subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "push", "-u", "origin", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "remote", "set-head", "origin", "main"], cwd=repo, check=True, capture_output=True)
    return repo, bare


def test_create_project_and_task_flow():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        project = client.post(
            "/projects",
            json={"name": "ShipBae", "repo_path": str(repo), "default_branch": "main"},
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(
            "/tasks",
            json={"project_id": project_id, "title": "Fix Canonical", "prompt": "Fix canonical tags", "model": "default"},
        )
        assert task.status_code == 200
        body = task.json()
        # Branch/folder prefix is the zenbar Project's name (slugified), not
        # the generic "task", so the Codex app's own UI can show which
        # project a session belongs to at a glance.
        assert body["workspace_ref"].startswith("shipbae/fix-canonical-")
        assert body["runtime_session_id"].startswith("mock-")
        assert Path(body["workspace_path"]).exists()
        # Task workspaces default to git worktrees of the project's repo
        # (not standalone clones) so every task shares one Codex project
        # trust entry instead of accumulating one per task.
        assert body["workspace_type"] == "worktree"

        asyncio.run(asyncio.sleep(0.08))

        events = client.get(f"/tasks/{body['id']}/events")
        assert events.status_code == 200
        event_types = [item["type"] for item in events.json()]
        assert "result_approval_requested" in event_types


def test_create_project_registers_codex_trust_entry(tmp_path, monkeypatch):
    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "config.toml").write_text('model = "gpt-5.5"\n')
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        project = client.post(
            "/projects",
            json={"name": "Trust Me", "repo_path": str(repo), "default_branch": "main"},
        )
        assert project.status_code == 200

        config_text = (codex_home / "config.toml").read_text()
        assert f'[projects."{repo}"]' in config_text
        assert 'trust_level = "trusted"' in config_text
        # Unrelated settings must survive untouched.
        assert 'model = "gpt-5.5"' in config_text


def test_create_plan_task_flow():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        project = client.post(
            "/projects",
            json={"name": "Planner", "repo_path": str(repo), "default_branch": "main"},
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(
            "/tasks",
            json={
                "project_id": project_id,
                "title": "Plan Canonical",
                "prompt": "Create an implementation plan",
                "model": "default",
                "execution_mode": "plan",
            },
        )
        assert task.status_code == 200
        body = task.json()
        assert body["execution_mode"] == "plan"

        asyncio.run(asyncio.sleep(0.08))

        events = client.get(f"/tasks/{body['id']}/events")
        assert events.status_code == 200
        event_types = [item["type"] for item in events.json()]
        assert "plan_updated" in event_types
        assert "plan_delta" in event_types
        assert "completed" in event_types


def test_approve_task():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Gokkan Keeper", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Add Dashboard", "prompt": "Add dashboard", "model": "default"},
        ).json()

        response = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert response.status_code == 200
        assert response.json()["status"] == "completed"


def test_followup_turn_appends_new_run_without_mutating_previous_run():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Followup", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Session flow", "prompt": "Do work", "model": "default"},
        ).json()

        approved = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert approved.status_code == 200
        before = approved.json()
        assert before["status"] == "completed"
        assert len(before["runs"]) == 1
        first_run_id = before["runs"][0]["id"]
        assert before["runs"][0]["status"] == "completed"

        followup = client.post(
            f"/sessions/{before['session_id']}/turns",
            json={"content": "Please tighten spacing."},
        )
        assert followup.status_code == 200
        body = followup.json()
        assert len(body["runs"]) == 2
        assert body["runs"][0]["id"] == first_run_id
        assert body["runs"][0]["status"] == "completed"
        assert body["runs"][1]["parent_run_id"] == first_run_id
        assert body["turns"][-1]["role"] == "user"
        assert body["turns"][-1]["content"] == "Please tighten spacing."

        events = client.get(f"/tasks/{task['id']}/events")
        assert events.status_code == 200
        assert any(
            item["payload_json"] and item["payload_json"].get("role") == "user" and item["message"] == "Please tighten spacing."
            for item in events.json()
        )


def test_followup_turn_rejects_while_run_is_active():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Followup active guard", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Active", "prompt": "Do work", "model": "default"},
        ).json()

        response = client.post(
            f"/sessions/{task['id']}/turns",
            json={"content": "run another pass"},
        )
        assert response.status_code == 409


def test_stop_task_success_and_invalid_transition():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Stop Guard", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Stop now", "prompt": "Do work", "model": "default"},
        ).json()

        stopped = client.post(f"/tasks/{task['id']}/stop", json={"actor": "pytest"})
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "stopped"

        invalid = client.post(f"/tasks/{task['id']}/stop", json={"actor": "pytest"})
        assert invalid.status_code == 409
        assert "cannot be stopped" in invalid.json()["detail"]


def test_stream_task_404_for_missing_task():
    response = client.get("/tasks/missing-task-id/stream")
    assert response.status_code == 404
    assert response.json()["detail"] == "Task not found"


def test_stream_task_emits_sse_payload_shape():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "SSE Shape", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Stream me", "prompt": "Do work", "model": "default"},
        ).json()

        async def collect_once() -> str:
            iterator = broker.subscribe(task["id"])
            publish_task = asyncio.create_task(broker.publish(task["id"], {"event": {"type": "agent_status", "message": "hi"}}))
            try:
                line = await asyncio.wait_for(anext(iterator), timeout=0.5)
            finally:
                await iterator.aclose()
                await publish_task
            return line

        line = asyncio.run(collect_once())
        assert line.startswith("data: ")
        payload = json.loads(line.removeprefix("data: "))
        assert payload["event"]["type"] == "agent_status"
        assert payload["event"]["message"] == "hi"


def test_invalid_retry_transition():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Sumi", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Initial task", "prompt": "Do work", "model": "default"},
        ).json()

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest"})
        assert response.status_code == 409


def test_plan_task_starts_without_collaboration_mode_list(monkeypatch):
    from app.main import orchestrator

    async def no_modes():
        return None

    monkeypatch.setattr(orchestrator.adapter, "list_collaboration_modes", no_modes)

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "No Mode Support", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        response = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Plan task",
                "prompt": "Create a plan",
                "model": "default",
                "execution_mode": "plan",
            },
        )

        assert response.status_code == 200
        body = response.json()
        asyncio.run(asyncio.sleep(0.08))
        events = client.get(f"/tasks/{body['id']}/events")
        messages = [item["message"] for item in events.json()]
        assert any("attempting direct plan mode start" in message for message in messages)


def test_runtime_models_endpoint_uses_cache(monkeypatch):
    from app.main import model_catalog, orchestrator

    calls = {"count": 0}

    async def list_models():
        calls["count"] += 1
        return ["GPT-5.4", "GPT-5.3-Codex"]

    monkeypatch.setattr(orchestrator.adapter, "list_models", list_models)
    model_catalog.clear_cache()

    first = client.get("/runtime/models")
    second = client.get("/runtime/models")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["models"] == [{"id": "default"}, {"id": "GPT-5.4"}, {"id": "GPT-5.3-Codex"}]
    assert second.json()["models"] == first.json()["models"]
    assert calls["count"] == 1


def test_runtime_models_endpoint_falls_back_when_runtime_unavailable(monkeypatch):
    from app.main import model_catalog, orchestrator

    async def list_models():
        raise RuntimeError("runtime unavailable")

    monkeypatch.setattr(orchestrator.adapter, "list_models", list_models)
    model_catalog.clear_cache()

    response = client.get("/runtime/models")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "fallback"
    assert body["models"] == [{"id": "default"}]


def test_ws_subscribe_events_emits_idle_heartbeat():
    from app.runtime import AppServerWebSocketAdapter, SessionState

    async def run() -> None:
        adapter = AppServerWebSocketAdapter("ws://example.invalid")
        adapter._idle_event_heartbeat_seconds = 0.01
        adapter._sessions["s1"] = SessionState(thread_id="s1")
        adapter._reader_task = asyncio.create_task(asyncio.sleep(0.1))
        try:
            event = await asyncio.wait_for(anext(adapter.subscribe_events("s1")), timeout=0.2)
        finally:
            adapter._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await adapter._reader_task
        assert event.type == "agent_status"
        assert event.payload == {"reason": "idle_heartbeat"}

    asyncio.run(run())


def test_ws_subscribe_events_fails_when_reader_task_stopped():
    from app.runtime import AppServerWebSocketAdapter, SessionState

    async def run() -> None:
        adapter = AppServerWebSocketAdapter("ws://example.invalid")
        adapter._idle_event_heartbeat_seconds = 0.01
        adapter._sessions["s1"] = SessionState(thread_id="s1")

        async def done_reader() -> None:
            return None

        adapter._reader_task = asyncio.create_task(done_reader())
        await adapter._reader_task
        with pytest.raises(RuntimeError, match="stream reader stopped"):
            await asyncio.wait_for(anext(adapter.subscribe_events("s1")), timeout=0.2)

    asyncio.run(run())


def test_create_task_rejects_invalid_model():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Invalid Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        response = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Bad model", "prompt": "Do work", "model": "not-a-model"},
        )
        assert response.status_code == 400
        assert "Invalid model" in response.json()["detail"]
        assert "default" in response.json()["detail"]


def test_create_task_requires_model_field():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Missing Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        response = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "No model", "prompt": "Do work"},
        )
    assert response.status_code == 422


def test_task_workspace_commit_and_push_flow():
    with TemporaryDirectory() as tmpdir:
        # Task workspaces are git worktrees of the project's repo_path (see
        # workspace.prepare_workspace), which share repo_path's own .git/config
        # rather than getting an auto-configured "origin" the way a standalone
        # `git clone` would. Pushing therefore needs repo_path to have a real
        # origin remote, same as any real zenbar project does.
        repo, bare = init_repo_with_remote_paths(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Git Ops", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Commit push", "prompt": "Do work", "model": "default"},
        ).json()

        workspace_path = task["workspace_path"]
        assert workspace_path
        new_file = Path(workspace_path) / "NEW_FILE.md"
        new_file.write_text("new content\n")

        commit = client.post(
            f"/tasks/{task['id']}/commit",
            json={"actor": "pytest", "message": "Add NEW_FILE"},
        )
        assert commit.status_code == 200
        commit_body = commit.json()
        assert commit_body["ok"] is True
        assert commit_body["branch"].startswith("git-ops/")

        push = client.post(
            f"/tasks/{task['id']}/push",
            json={"actor": "pytest", "remote": "origin", "set_upstream": True},
        )
        assert push.status_code == 200
        push_body = push.json()
        assert push_body["ok"] is True
        branch = push_body["branch"]
        assert branch

        remote_heads = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
            cwd=bare,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        assert branch in remote_heads


def test_task_workspace_push_uses_project_origin_remote():
    with TemporaryDirectory() as tmpdir:
        repo, bare = init_repo_with_remote_paths(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Git Ops Remote", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Commit push remote", "prompt": "Do work", "model": "default"},
        ).json()

        workspace_path = task["workspace_path"]
        assert workspace_path
        new_file = Path(workspace_path) / "REMOTE_FILE.md"
        new_file.write_text("remote content\n")

        commit = client.post(
            f"/tasks/{task['id']}/commit",
            json={"actor": "pytest", "message": "Add REMOTE_FILE"},
        )
        assert commit.status_code == 200

        push = client.post(
            f"/tasks/{task['id']}/push",
            json={"actor": "pytest", "remote": "origin", "set_upstream": True},
        )
        assert push.status_code == 200
        branch = push.json()["branch"]
        assert branch

        remote_heads = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
            cwd=bare,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        assert branch in remote_heads


def test_task_workspace_commit_fails_without_changes():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Git Ops Empty", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "No changes", "prompt": "Do work", "model": "default"},
        ).json()

        response = client.post(
            f"/tasks/{task['id']}/commit",
            json={"actor": "pytest", "message": "Should fail"},
        )
        assert response.status_code == 409
        assert "No changes to commit" in response.json()["detail"]


def test_discover_project_uses_remote_default_branch():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo_with_remote(tmpdir)

        response = client.post("/projects/discover", json={"path": str(repo)})

        assert response.status_code == 200
        body = response.json()
        assert body["name"] == repo.name
        assert body["repo_path"] == str(repo.resolve())
        assert body["default_branch"] == "main"
        assert body["current_branch"] == "main"
        assert body["is_git_repo"] is True


def test_discover_project_rejects_non_git_directory():
    with TemporaryDirectory() as tmpdir:
        response = client.post("/projects/discover", json={"path": tmpdir})
        assert response.status_code == 400
        assert "git repository" in response.json()["detail"]


def test_discover_project_falls_back_to_current_branch_without_origin_head():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        subprocess.run(["git", "checkout", "-b", "feature/picker"], cwd=repo, check=True, capture_output=True)
        response = client.post("/projects/discover", json={"path": str(repo)})

        assert response.status_code == 200
        assert response.json()["default_branch"] == "feature/picker"


def test_discover_project_falls_back_to_main_on_detached_head():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)

        subprocess.run(["git", "checkout", "--detach", "HEAD"], cwd=repo, check=True, capture_output=True)
        response = client.post("/projects/discover", json={"path": str(repo)})

        assert response.status_code == 200
        assert response.json()["default_branch"] == "main"


def test_discover_project_cancelled(monkeypatch):
    from app import main
    from app.repo_discovery import FolderSelectionCancelled

    def cancel(_: str | None = None):
        raise FolderSelectionCancelled("Folder selection was cancelled")

    monkeypatch.setattr(main, "discover_repository", cancel)

    response = client.post("/projects/discover", json={})
    assert response.status_code == 409
    assert "cancelled" in response.json()["detail"].lower()


def test_user_input_request_updates_status_and_responds():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Interactive", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Need Input", "prompt": "Ask a question", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            append_event(
                db,
                current,
                RuntimeEvent(
                    type="user_input_requested",
                    message="User input requested: 1 question(s)",
                    payload={
                        "request_id": "req-1",
                        "method": "item/tool/requestUserInput",
                        "questions": [
                            {
                                "id": "q1",
                                "header": "Branch",
                                "question": "Which branch should be used?",
                                "isOther": False,
                                "isSecret": False,
                                "options": [{"label": "main", "description": "Default branch"}],
                            }
                        ],
                    },
                ),
            )

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "waiting_user_input"
        assert detail.json()["pending_questions"][0]["id"] == "q1"

        response = client.post(
            f"/tasks/{task['id']}/respond",
            json={"actor": "pytest", "answers": {"q1": ["main"]}},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "running"


def test_terminal_task_status_is_not_downgraded_by_late_agent_status_event():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Terminal Status Guard", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Guard terminal", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "completed"
            db.add(current)
            db.commit()
            append_event(
                db,
                current,
                RuntimeEvent(type="agent_status", message="Late status update"),
            )

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "completed"


def test_waiting_result_approval_is_not_downgraded_by_agent_status_event():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Waiting Approval Guard", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Keep waiting", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            append_event(
                db,
                current,
                RuntimeEvent(
                    type="result_approval_requested",
                    message="Need approval",
                    payload={"request_id": "req-approve"},
                ),
            )
            current = get_task(db, task["id"])
            assert current is not None
            append_event(
                db,
                current,
                RuntimeEvent(type="agent_status", message="Heartbeat while waiting"),
            )

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "waiting_result_approval"
        assert detail.json()["pending_interaction_type"] == "result_approval"


def test_waiting_result_approval_transitions_to_running_on_approval_granted():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Approval Resume", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Resume run", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            append_event(
                db,
                current,
                RuntimeEvent(
                    type="result_approval_requested",
                    message="Need approval",
                    payload={"request_id": "req-approve"},
                ),
            )
            current = get_task(db, task["id"])
            assert current is not None
            append_event(
                db,
                current,
                RuntimeEvent(
                    type="result_approval_granted",
                    message="Approved",
                    payload={"request_id": "req-approve"},
                ),
            )

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "running"
        assert detail.json()["pending_interaction_type"] is None


def test_approve_rejected_outside_waiting_result_approval():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Approval Gate", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Plan First", "prompt": "Do work", "model": "default", "execution_mode": "plan"},
        ).json()

        response = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert response.status_code == 409


def test_get_task_diff_clears_persisted_diff_when_workspace_is_clean_and_runtime_session_is_stale():
    # Workspace git diff is ground truth (see TaskOrchestrator.refresh_diff): a
    # persisted diff from a prior run must not linger once the workspace is
    # actually clean (e.g. changes were committed), even if the runtime
    # session that produced it is no longer reachable. This used to assert
    # the opposite (persisted diff wins) before that ground-truth behavior
    # was introduced; test_get_task_diff_falls_back_to_workspace_git_diff_when_runtime_diff_is_unavailable
    # covers the complementary case where the workspace *does* have real
    # uncommitted changes.
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Stale Session", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Stale diff", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.runtime_session_id = "missing-session"
            current.latest_diff_summary = "Persisted diff"
            current.latest_diff_files_json = "[\"README.md\"]"
            current.latest_diff_raw = "diff --git a/README.md b/README.md"
            db.add(current)
            db.commit()

        response = client.get(f"/tasks/{task['id']}/diff")
        assert response.status_code == 200
        assert response.json()["summary"] == ""
        assert response.json()["files_changed"] == []


def test_get_task_diff_falls_back_to_workspace_git_diff_when_runtime_diff_is_unavailable():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Workspace Diff Fallback", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Workspace diff", "prompt": "Do work", "model": "default"},
        ).json()

        workspace_path = task["workspace_path"]
        assert workspace_path
        readme = Path(workspace_path) / "README.md"
        readme.write_text("hello\nworkspace diff change\n")

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.runtime_session_id = "missing-session"
            current.latest_diff_summary = ""
            current.latest_diff_files_json = "[]"
            current.latest_diff_raw = None
            db.add(current)
            db.commit()

        response = client.get(f"/tasks/{task['id']}/diff")
        assert response.status_code == 200
        body = response.json()
        assert body["summary"].startswith("Updated")
        assert "README.md" in body["files_changed"]


def test_task_detail_reconnect_reuses_runtime_session_stream(monkeypatch):
    from app import main

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Reconnect Detail", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Reconnect me", "prompt": "Do work", "model": "default"},
        ).json()

        calls: list[tuple[str, str | None]] = []

        def ensure_runtime_stream(task_id: str, session_id: str | None) -> None:
            calls.append((task_id, session_id))

        monkeypatch.setattr(main.orchestrator, "ensure_runtime_stream", ensure_runtime_stream)
        response = client.get(f"/tasks/{task['id']}")

        assert response.status_code == 200
        assert calls == [(task["id"], task["runtime_session_id"])]


def test_task_events_reconnect_reuses_runtime_session_stream(monkeypatch):
    from app import main

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Reconnect Events", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Reconnect events", "prompt": "Do work", "model": "default"},
        ).json()

        calls: list[tuple[str, str | None]] = []

        def ensure_runtime_stream(task_id: str, session_id: str | None) -> None:
            calls.append((task_id, session_id))

        monkeypatch.setattr(main.orchestrator, "ensure_runtime_stream", ensure_runtime_stream)
        response = client.get(f"/tasks/{task['id']}/events")

        assert response.status_code == 200
        assert calls == [(task["id"], task["runtime_session_id"])]


def test_task_detail_reconciles_stale_runtime_session_to_failed():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Reconcile Stale Session", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Reconcile me", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "running"
            current.runtime_session_id = "missing-session"
            db.add(current)
            db.commit()

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        body = detail.json()
        assert body["status"] == "failed"
        assert body["runtime_session_id"] is None

        events = client.get(f"/tasks/{task['id']}/events")
        assert events.status_code == 200
        assert any(
            item["type"] == "failed" and (item["payload_json"] or {}).get("reason") == "stale_runtime_session"
            for item in events.json()
        )


def test_reconcile_active_tasks_marks_stale_sessions_failed():
    from app.main import orchestrator

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Reconcile Startup", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Startup reconcile", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "running"
            current.runtime_session_id = "missing-session"
            db.add(current)
            db.commit()

        reconciled = asyncio.run(orchestrator.reconcile_active_tasks())
        assert reconciled >= 1

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "failed"
        assert detail.json()["runtime_session_id"] is None


def test_ensure_runtime_stream_noops_without_running_loop(monkeypatch):
    from app.main import orchestrator

    calls: list[tuple[str, str]] = []

    def fake_start_background_consumer(
        task_id: str,
        session_id: str,
        loop=None,
    ) -> None:
        calls.append((task_id, session_id))

    monkeypatch.setattr(orchestrator.adapter, "stream_in_background", True)
    monkeypatch.setattr(orchestrator, "_start_background_consumer", fake_start_background_consumer)

    orchestrator.ensure_runtime_stream("task-1", "session-1")

    assert calls == []


def test_project_soft_delete_hides_project_and_blocks_project_task_endpoints():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Soft Delete", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Keep History", "prompt": "Preserve records", "model": "default"},
        ).json()

        first_delete = client.delete(f"/projects/{project['id']}")
        assert first_delete.status_code == 204

        second_delete = client.delete(f"/projects/{project['id']}")
        assert second_delete.status_code == 204

        projects = client.get("/projects")
        assert projects.status_code == 200
        assert all(item["id"] != project["id"] for item in projects.json())

        list_tasks_after_delete = client.get(f"/projects/{project['id']}/tasks")
        assert list_tasks_after_delete.status_code == 404
        assert list_tasks_after_delete.json()["detail"] == "Project not found"

        create_task_after_delete = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Blocked", "prompt": "Should fail", "model": "default"},
        )
        assert create_task_after_delete.status_code == 404
        assert create_task_after_delete.json()["detail"] == "Project not found"

        existing_task_detail = client.get(f"/tasks/{task['id']}")
        assert existing_task_detail.status_code == 200
        assert existing_task_detail.json()["id"] == task["id"]


def test_respond_marks_task_failed_when_runtime_session_is_stale():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Stale Input", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Need input", "prompt": "Ask a question", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.runtime_session_id = "missing-session"
            append_event(
                db,
                current,
                RuntimeEvent(
                    type="user_input_requested",
                    message="User input requested: 1 question(s)",
                    payload={"request_id": "9", "questions": [{"id": "q1", "header": "Branch", "question": "Which branch?"}]},
                ),
            )

        response = client.post(
            f"/tasks/{task['id']}/respond",
            json={"actor": "pytest", "answers": {"q1": ["main"]}},
        )
        assert response.status_code == 409
        assert "Retry the task" in response.json()["detail"]

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        assert detail.json()["status"] == "failed"
        assert detail.json()["runtime_session_id"] is None
        assert detail.json()["pending_interaction_type"] is None


def test_retry_restarts_task_when_runtime_session_is_missing():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Retry Missing Session", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Retry task", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "failed"
            current.runtime_session_id = None
            current.pending_interaction_type = None
            current.pending_request_id = None
            current.pending_request_payload_json = None
            db.add(current)
            db.commit()

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest"})
        assert response.status_code == 200
        body = response.json()
        assert body["status"] in {"running", "waiting_result_approval"}
        assert body["runtime_session_id"]


def test_retry_defaults_model_for_legacy_task_and_records_event():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Legacy Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Legacy retry", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "failed"
            current.runtime_session_id = None
            current.model = None
            db.add(current)
            db.commit()

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest"})
        assert response.status_code == 200
        payload = response.json()
        assert payload["model"] == "default"

        events = client.get(f"/tasks/{task['id']}/events")
        assert events.status_code == 200
        fallback_event = next((item for item in events.json() if item["message"] == "Model defaulted for legacy task retry"), None)
        assert fallback_event is not None
        assert fallback_event["payload_json"]["type"] == "model_defaulted"
        assert fallback_event["payload_json"]["reason"] == "legacy_task"
        assert fallback_event["payload_json"]["model"] == "default"


def test_retry_restarts_task_when_runtime_session_is_stale():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Retry Stale Session", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Retry stale task", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "failed"
            current.runtime_session_id = "missing-session"
            db.add(current)
            db.commit()

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest"})
        assert response.status_code == 200
        body = response.json()
        assert body["status"] in {"starting", "running", "waiting_result_approval"}
        assert body["runtime_session_id"]
        assert body["runtime_session_id"] != "missing-session"


def test_stale_runtime_session_after_completion_keeps_completed_status(monkeypatch):
    from app.main import orchestrator

    async def stale_stream(_session_id: str):
        if False:
            yield RuntimeEvent(type="agent_status", message="unused")
        raise RuntimeError("Unknown Codex App Server session")

    monkeypatch.setattr(orchestrator.adapter, "stream_in_background", True)
    monkeypatch.setattr(orchestrator.adapter, "subscribe_events", stale_stream)

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Terminal Stale Session", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Completed stale", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "completed"
            current.runtime_session_id = "missing-session"
            db.add(current)
            db.commit()

        asyncio.run(orchestrator._consume_events(task["id"], "missing-session"))

        detail = client.get(f"/tasks/{task['id']}")
        assert detail.status_code == 200
        body = detail.json()
        assert body["status"] == "completed"
        assert body["runtime_session_id"] is None

        events = client.get(f"/tasks/{task['id']}/events")
        assert events.status_code == 200
        latest = events.json()[-1]
        assert latest["type"] == "agent_status"
        assert latest["payload_json"]["reason"] == "stale_runtime_session_terminal"


def test_retry_accepts_model_override_and_restarts_with_new_model(monkeypatch):
    from app.main import model_catalog, orchestrator

    async def list_models():
        return ["default", "gpt-5"]

    model_catalog.clear_cache()
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Retry Model Override", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Retry override", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "failed"
            db.add(current)
            db.commit()

        # ensure override value is allowed under fallback/default-centric catalog
        monkeypatch.setattr(orchestrator.adapter, "list_models", list_models)
        model_catalog.clear_cache()
        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest", "model": "gpt-5"})
        assert response.status_code == 200
        body = response.json()
        assert body["model"] == "gpt-5"
        assert body["runtime_session_id"]

        events = client.get(f"/tasks/{task['id']}/events").json()
        assert any(item["message"] == "Retry requested with model override: gpt-5" for item in events)


def test_retry_rejects_invalid_model_override():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Retry Invalid Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Retry invalid", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            assert current is not None
            current.status = "failed"
            db.add(current)
            db.commit()

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest", "model": "not-a-model"})
        assert response.status_code == 400
        assert "Invalid model" in response.json()["detail"]


def test_ensure_schema_migrates_waiting_approval_to_waiting_result_approval():
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM tasks")
        connection.exec_driver_sql("DELETE FROM projects")
        connection.exec_driver_sql(
            "INSERT INTO projects (id, name, repo_path, default_branch, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
            ("project-migrate", "Migration", "/tmp/repo", "main"),
        )
        connection.exec_driver_sql(
            "INSERT INTO tasks (id, project_id, title, prompt, status, execution_mode, workspace_type, workspace_ref, latest_diff_summary, latest_diff_files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            ("task-migrate", "project-migrate", "Legacy", "Prompt", "waiting_approval", "execute", "branch", "task/legacy-a1b2", "", "[]"),
        )

    ensure_schema()

    with SessionLocal() as db:
        task = get_task(db, "task-migrate")
        assert task is not None
        assert task.status == "waiting_result_approval"


def test_get_runtime_profiles_reads_codex_home_config_profiles(tmp_path, monkeypatch):
    (tmp_path / "azure-sqlgen.config.toml").write_text(
        'model = "gpt-5.5"\nmodel_provider = "azure"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n'
    )
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    response = client.get("/runtime/profiles")

    assert response.status_code == 200
    body = response.json()
    assert body["profiles"] == [
        {
            "id": "azure-sqlgen",
            "description": "gpt-5.5, approval=on-request, sandbox=workspace-write",
            "model": "gpt-5.5",
        }
    ]


def test_task_can_be_created_with_a_profile(tmp_path, monkeypatch):
    (tmp_path / "azure-sqlgen.config.toml").write_text('model = "gpt-5.5"\nmodel_provider = "azure"\n')
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Profile Task", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Profile task",
                "prompt": "Do work",
                "model": "default",
                "profile": "azure-sqlgen",
            },
        ).json()
        assert task["profile"] == "azure-sqlgen"


def test_task_can_be_created_with_a_profile_whose_model_is_outside_the_generic_catalog(tmp_path, monkeypatch):
    # A profile's own declared model always wins over an explicit model pick
    # (see TaskForm's profileControlsModel on the frontend), and that model
    # may be a provider-specific deployment name -- e.g. an Azure OpenAI
    # deployment like "inoberry-amansman77-gpt-5.5" -- that isn't in the
    # generic engine-wide model catalog at all. Creating a task with such a
    # profile used to 400 with "Invalid model" because the server validated
    # the submitted model against that generic catalog regardless of the
    # profile. The frontend sends exactly the profile's model in this case
    # (matches ThreadForm's profileControlsModel behavior), so this
    # reproduces the real request shape.
    (tmp_path / "azure-sqlgen.config.toml").write_text(
        'model = "inoberry-amansman77-gpt-5.5"\nmodel_provider = "azure"\n'
    )
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Profile Custom Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        response = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Profile task",
                "prompt": "Do work",
                "model": "inoberry-amansman77-gpt-5.5",
                "profile": "azure-sqlgen",
            },
        )
        assert response.status_code == 200
        task = response.json()
        assert task["profile"] == "azure-sqlgen"
        assert task["model"] == "inoberry-amansman77-gpt-5.5"


def test_task_creation_still_rejects_invalid_model_without_a_profile():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "No Profile", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        response = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Bad model",
                "prompt": "Do work",
                "model": "not-a-real-model",
            },
        )
        assert response.status_code == 400
        assert "Invalid model" in response.json()["detail"]


def test_task_creation_rejects_invalid_model_when_profile_has_no_declared_model(tmp_path, monkeypatch):
    # A profile that doesn't itself declare a model (e.g. it only sets
    # approval_policy/sandbox_mode) must not bypass model validation.
    (tmp_path / "careful.config.toml").write_text('approval_policy = "untrusted"\n')
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Profile No Model", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        response = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Bad model",
                "prompt": "Do work",
                "model": "not-a-real-model",
                "profile": "careful",
            },
        )
        assert response.status_code == 400
        assert "Invalid model" in response.json()["detail"]


def _create_project_for_prompts() -> dict:
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        return client.post(
            "/projects",
            json={"name": "Prompts Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()


def test_project_prompts_crud_flow():
    project = _create_project_for_prompts()

    empty = client.get(f"/projects/{project['id']}/prompts")
    assert empty.status_code == 200
    assert empty.json() == []

    created = client.post(
        f"/projects/{project['id']}/prompts",
        json={"title": "Bug triage", "content": "Look at open issues and triage them."},
    )
    assert created.status_code == 201
    prompt = created.json()
    assert prompt["title"] == "Bug triage"
    assert prompt["content"] == "Look at open issues and triage them."
    assert prompt["project_id"] == project["id"]

    second = client.post(
        f"/projects/{project['id']}/prompts",
        json={"title": "Release notes", "content": "Draft release notes for the latest changes."},
    ).json()
    assert second["position"] > prompt["position"]

    listed = client.get(f"/projects/{project['id']}/prompts").json()
    assert [p["title"] for p in listed] == ["Bug triage", "Release notes"]

    updated = client.patch(
        f"/projects/{project['id']}/prompts/{prompt['id']}",
        json={"title": "Bug triage (updated)"},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Bug triage (updated)"
    assert updated.json()["content"] == prompt["content"]

    deleted = client.delete(f"/projects/{project['id']}/prompts/{prompt['id']}")
    assert deleted.status_code == 204

    remaining = client.get(f"/projects/{project['id']}/prompts").json()
    assert [p["id"] for p in remaining] == [second["id"]]


def test_project_prompts_404_for_unknown_project_or_prompt():
    project = _create_project_for_prompts()

    assert client.get("/projects/does-not-exist/prompts").status_code == 404
    assert client.post(
        "/projects/does-not-exist/prompts", json={"title": "x", "content": "y"}
    ).status_code == 404

    prompt = client.post(
        f"/projects/{project['id']}/prompts", json={"title": "x", "content": "y"}
    ).json()

    other_project = _create_project_for_prompts()
    assert client.patch(
        f"/projects/{other_project['id']}/prompts/{prompt['id']}", json={"title": "z"}
    ).status_code == 404
    assert client.delete(f"/projects/{other_project['id']}/prompts/{prompt['id']}").status_code == 404
    assert client.patch(
        f"/projects/{project['id']}/prompts/does-not-exist", json={"title": "z"}
    ).status_code == 404


def test_project_pipelines_crud_flow():
    project = _create_project_for_prompts()
    prompt_a = client.post(
        f"/projects/{project['id']}/prompts", json={"title": "A", "content": "Do A."}
    ).json()
    prompt_b = client.post(
        f"/projects/{project['id']}/prompts", json={"title": "B", "content": "Do B."}
    ).json()

    empty = client.get(f"/projects/{project['id']}/pipelines")
    assert empty.status_code == 200
    assert empty.json() == []

    created = client.post(
        f"/projects/{project['id']}/pipelines",
        json={"name": "A then B", "prompt_ids": [prompt_a["id"], prompt_b["id"]]},
    )
    assert created.status_code == 201
    pipeline = created.json()
    assert pipeline["name"] == "A then B"
    assert pipeline["prompt_ids"] == [prompt_a["id"], prompt_b["id"]]
    assert pipeline["project_id"] == project["id"]

    listed = client.get(f"/projects/{project['id']}/pipelines").json()
    assert [p["id"] for p in listed] == [pipeline["id"]]

    reordered = client.patch(
        f"/projects/{project['id']}/pipelines/{pipeline['id']}",
        json={"name": "B then A", "prompt_ids": [prompt_b["id"], prompt_a["id"]]},
    )
    assert reordered.status_code == 200
    assert reordered.json()["name"] == "B then A"
    assert reordered.json()["prompt_ids"] == [prompt_b["id"], prompt_a["id"]]

    deleted = client.delete(f"/projects/{project['id']}/pipelines/{pipeline['id']}")
    assert deleted.status_code == 204
    assert client.get(f"/projects/{project['id']}/pipelines").json() == []


def test_project_pipelines_reject_prompts_from_another_project():
    project = _create_project_for_prompts()
    other_project = _create_project_for_prompts()
    foreign_prompt = client.post(
        f"/projects/{other_project['id']}/prompts", json={"title": "Foreign", "content": "..."}
    ).json()

    response = client.post(
        f"/projects/{project['id']}/pipelines",
        json={"name": "Bad", "prompt_ids": [foreign_prompt["id"]]},
    )
    assert response.status_code == 400


def test_project_pipelines_404_for_unknown_project_or_pipeline():
    project = _create_project_for_prompts()

    assert client.get("/projects/does-not-exist/pipelines").status_code == 404
    prompt = client.post(
        f"/projects/{project['id']}/prompts", json={"title": "x", "content": "y"}
    ).json()
    assert client.post(
        "/projects/does-not-exist/pipelines", json={"name": "x", "prompt_ids": [prompt["id"]]}
    ).status_code == 404

    pipeline = client.post(
        f"/projects/{project['id']}/pipelines", json={"name": "x", "prompt_ids": [prompt["id"]]}
    ).json()

    other_project = _create_project_for_prompts()
    assert client.patch(
        f"/projects/{other_project['id']}/pipelines/{pipeline['id']}", json={"name": "z"}
    ).status_code == 404
    assert client.delete(f"/projects/{other_project['id']}/pipelines/{pipeline['id']}").status_code == 404
    assert client.patch(
        f"/projects/{project['id']}/pipelines/does-not-exist", json={"name": "z"}
    ).status_code == 404


def test_pipeline_execution_auto_advances_through_all_steps_and_completes():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Pipeline Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        prompt_specs = [
            ("Step 1", "Do the first thing."),
            ("Step 2", "Do the second thing."),
            ("Step 3", "Do the third thing."),
        ]
        prompt_ids = []
        for title, content in prompt_specs:
            prompt = client.post(
                f"/projects/{project['id']}/prompts",
                json={"title": title, "content": content},
            ).json()
            prompt_ids.append(prompt["id"])

        pipeline = client.post(
            f"/projects/{project['id']}/pipelines",
            json={"name": "Full Flow", "prompt_ids": prompt_ids},
        )
        assert pipeline.status_code == 201
        pipeline_id = pipeline.json()["id"]

        conversation = client.post(
            "/conversations",
            json={"project_id": project["id"], "title": "Pipeline run"},
        ).json()

        response = client.post(
            f"/conversations/{conversation['id']}/messages",
            json={"content": "", "pipeline_id": pipeline_id},
        )
        assert response.status_code == 201
        body = response.json()

        # Fully automatic (no per-step approval): by the time the request
        # returns, all 3 steps have run to completion via the mock adapter's
        # synchronous event consumption.
        assert body["task_pipeline_id"] == pipeline_id
        assert body["task_pipeline_name"] == "Full Flow"
        assert body["task_pipeline_step_index"] == 2
        assert body["task_pipeline_total_steps"] == 3
        assert body["task_status"] == "completed"

        # Each step's prompt content appears as its own user message, in order.
        user_messages = [m["content"] for m in body["messages"] if m["role"] == "user"]
        assert user_messages == [content for _, content in prompt_specs]

        task = client.get(f"/tasks/{body['task_id']}").json()
        assert task["status"] == "completed"
        assert task["pipeline_step_index"] == 2
        assert task["pipeline_total_steps"] == 3


def test_pipeline_start_prepends_typed_content_to_first_step_only():
    # Regression: starting a pipeline used to always send `content: ""` on
    # the frontend, and the backend fully discarded whatever was sent
    # anyway -- overwriting it outright with the first step's saved prompt.
    # That left no way to point a generic pipeline template (e.g. "Review
    # the issue and fix it.") at something specific (e.g. "Issue #123") when
    # starting it. Now typed content is prepended to step 1 only; steps 2+
    # come from pipeline_steps_json verbatim, untouched by what was typed.
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Pipeline Param Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        prompt_specs = [("Step 1", "Review the issue and fix it."), ("Step 2", "Open a PR.")]
        prompt_ids = []
        for title, content in prompt_specs:
            prompt = client.post(
                f"/projects/{project['id']}/prompts",
                json={"title": title, "content": content},
            ).json()
            prompt_ids.append(prompt["id"])

        pipeline_id = client.post(
            f"/projects/{project['id']}/pipelines",
            json={"name": "Parametrized Flow", "prompt_ids": prompt_ids},
        ).json()["id"]

        conversation = client.post(
            "/conversations",
            json={"project_id": project["id"], "title": "Pipeline run with param"},
        ).json()

        response = client.post(
            f"/conversations/{conversation['id']}/messages",
            json={"content": "Issue #123", "pipeline_id": pipeline_id},
        )
        assert response.status_code == 201
        body = response.json()

        user_messages = [m["content"] for m in body["messages"] if m["role"] == "user"]
        assert user_messages == [
            "Issue #123\n\nReview the issue and fix it.",
            "Open a PR.",
        ]

        task = client.get(f"/tasks/{body['task_id']}").json()
        assert task["prompt"] == "Issue #123\n\nReview the issue and fix it."


def test_pipeline_start_without_typed_content_still_works():
    # The empty-content case (pick a pipeline, send nothing) must keep
    # working exactly as before -- this is the common case for pipelines
    # whose first step needs no per-run parameter.
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Pipeline No Param Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        prompt_id = client.post(
            f"/projects/{project['id']}/prompts",
            json={"title": "Step 1", "content": "Do the thing."},
        ).json()["id"]
        pipeline_id = client.post(
            f"/projects/{project['id']}/pipelines",
            json={"name": "No Param Flow", "prompt_ids": [prompt_id]},
        ).json()["id"]
        conversation = client.post(
            "/conversations",
            json={"project_id": project["id"], "title": "Pipeline run no param"},
        ).json()

        response = client.post(
            f"/conversations/{conversation['id']}/messages",
            json={"content": "", "pipeline_id": pipeline_id},
        )
        assert response.status_code == 201
        user_messages = [m["content"] for m in response.json()["messages"] if m["role"] == "user"]
        assert user_messages == ["Do the thing."]


def test_pipeline_advances_from_a_plain_completed_status_too():
    # Regression: hit for real in production. _advance_pipeline_if_needed
    # used to only advance a pipeline from "waiting_result_approval" -- but
    # that status means the runtime paused *mid-turn* to ask permission for
    # one specific file edit or command (item/fileChange/requestApproval),
    # which most turns never trigger at all (e.g. the default
    # sandbox=workspace-write grants broad write access upfront, so there's
    # nothing to ask permission for). A real pipeline task ran a full turn
    # end to end -- ~450 events, dozens of file edits and commands -- and
    # went straight from "running" to "completed" without a single
    # approval request anywhere in it, so the pipeline silently stalled
    # after step 1 with no failure event and no visible sign anything was
    # wrong.
    #
    # Isolated on purpose rather than driven through a real pipeline start:
    # the mock adapter's own script always produces a
    # result_approval_requested event, which (via the pre-existing
    # approval branch's own cascade) runs a whole small pipeline to full
    # completion synchronously within one request -- there's no natural
    # point to catch it "paused after step 1" to exercise the new branch.
    # This constructs that state directly and checks _advance_pipeline_if_
    # needed's decision (call followup_task, not approve_task) instead.
    import app.service as service_module
    from app.main import orchestrator
    from app.repository import set_task_pipeline_step, set_task_status

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Pipeline Completed-Only Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Completed-only pipeline task",
                "prompt": "Do the first thing.",
                "model": "default",
            },
        ).json()

        followup_calls: list[tuple[str, str]] = []

        async def fake_followup_task(self, db, task, content, selected_skill=None):
            followup_calls.append((task.id, content))
            return set_task_status(db, task, "running")

        original_followup = service_module.TaskOrchestrator.followup_task
        original_approve = service_module.TaskOrchestrator.approve_task

        async def failing_approve_task(self, db, task):
            raise AssertionError("approve_task must not be called when the task is already completed")

        service_module.TaskOrchestrator.followup_task = fake_followup_task
        service_module.TaskOrchestrator.approve_task = failing_approve_task
        try:
            with SessionLocal() as db:
                db_task = get_task(db, task["id"])
                db_task.pipeline_id = "fake-pipeline-id"
                db_task.pipeline_name = "Fake Pipeline"
                db_task.pipeline_steps_json = json.dumps(
                    [
                        {"prompt_id": "p1", "title": "Step 1", "content": "Do the first thing."},
                        {"prompt_id": "p2", "title": "Step 2", "content": "Do the second thing."},
                    ]
                )
                db_task = set_task_pipeline_step(db, db_task, 0)
                db_task = set_task_status(db, db_task, "completed")

                db_task = asyncio.run(orchestrator._advance_pipeline_if_needed(db, db_task))

                assert db_task.pipeline_step_index == 1
        finally:
            service_module.TaskOrchestrator.followup_task = original_followup
            service_module.TaskOrchestrator.approve_task = original_approve

        assert followup_calls == [(task["id"], "Do the second thing.")]


def test_pipeline_stops_and_reports_failure_when_a_step_fails():
    from app.main import orchestrator
    from app.schemas import RuntimeEvent, RuntimeSession

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Pipeline Failure Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        prompt_ids = []
        for title, content in [("Step 1", "Do the first thing."), ("Step 2", "Do the second thing.")]:
            prompt_ids.append(
                client.post(
                    f"/projects/{project['id']}/prompts", json={"title": title, "content": content}
                ).json()["id"]
            )

        pipeline_id = client.post(
            f"/projects/{project['id']}/pipelines",
            json={"name": "Will Fail", "prompt_ids": prompt_ids},
        ).json()["id"]

        conversation = client.post(
            "/conversations",
            json={"project_id": project["id"], "title": "Pipeline failure run"},
        ).json()

        original_followup = orchestrator.adapter.followup_task

        async def failing_followup(session_id: str, message: str, selected_skill: str | None = None):
            # Simulate step 2 failing instead of completing normally.
            orchestrator.adapter._events.setdefault(session_id, []).append(
                RuntimeEvent(type="failed", message="Simulated step failure")
            )
            return RuntimeSession(session_id=session_id, effective_model="default")

        orchestrator.adapter.followup_task = failing_followup
        try:
            response = client.post(
                f"/conversations/{conversation['id']}/messages",
                json={"content": "", "pipeline_id": pipeline_id},
            )
        finally:
            orchestrator.adapter.followup_task = original_followup

        assert response.status_code == 201
        body = response.json()
        assert body["task_status"] == "failed"
        # Advanced to (and failed on) step index 1 -- the pipeline did not
        # silently skip ahead or retry.
        assert body["task_pipeline_step_index"] == 1


def test_task_prompt_no_longer_auto_instructs_commit_push_or_pull_request():
    # Regression: this prompt used to unconditionally tell execute-mode
    # tasks to "commit, push, and open a GitHub pull request" once done,
    # regardless of what the user's own prompt actually asked for. Removed
    # at the user's explicit request after it caused real problems: it fired
    # even for purely informational requests with no code-change intent
    # (pushing the agent to manufacture a change just to have something to
    # commit/PR against), and it hardcoded "GitHub pull request", which
    # doesn't hold for GitLab-backed projects -- the agent adapted by
    # opening a GitLab MR on its own, via ad-hoc token-based push auth whose
    # token then ended up logged in the task's event history. The user now
    # asks for commit/push/PR explicitly in the prompt itself when wanted.
    from app.runtime import _prompt_with_workspace
    from app.schemas import RuntimeStartRequest

    request = RuntimeStartRequest(
        task_id="t1",
        title="Fix thing",
        prompt="Fix the thing.",
        model="default",
        reasoning_effort="medium",
        repo_path="/srv/repo",
        working_directory="/tmp/ws",
        default_branch="main",
        execution_mode="execute",
        workspace_type="worktree",
        workspace_ref="proj/fix-thing-a1b2",
    )

    prompt = _prompt_with_workspace(request)

    assert "pull request" not in prompt.lower()
    assert "commit" not in prompt.lower()
    assert "push" not in prompt.lower()
    assert "do not merge" not in prompt.lower()
    # The workspace context and the user's own prompt text are still there.
    assert "proj/fix-thing-a1b2" in prompt
    assert "main" in prompt
    assert "Fix the thing." in prompt


def test_plan_mode_prompt_does_not_ask_for_a_pull_request():
    from app.runtime import _prompt_with_workspace
    from app.schemas import RuntimeStartRequest

    request = RuntimeStartRequest(
        task_id="t2",
        title="Plan thing",
        prompt="Plan the thing.",
        model="default",
        reasoning_effort="medium",
        repo_path="/srv/repo",
        working_directory="/tmp/ws",
        default_branch="main",
        execution_mode="plan",
        workspace_type="worktree",
        workspace_ref="proj/plan-thing-a1b2",
    )

    prompt = _prompt_with_workspace(request)

    assert "pull request" not in prompt.lower()


def test_classify_rate_limit_windows_distinguishes_by_duration():
    # Real shape returned by the App Server's account/rateLimits/read RPC,
    # confirmed live against the actual running server: a weekly window
    # reports windowDurationMins=10080 (7*24*60). No secondary/5h example
    # was available live, so this uses a plausible 300-minute value for it.
    from app.runtime import _classify_rate_limit_windows

    primary = {"usedPercent": 12, "windowDurationMins": 10080, "resetsAt": 1787844336}
    secondary = {"usedPercent": 40, "windowDurationMins": 300, "resetsAt": 1787700000}

    session, week = _classify_rate_limit_windows(primary, secondary)

    assert week is not None
    assert week.percent_used == 12
    assert session is not None
    assert session.percent_used == 40


def test_classify_rate_limit_windows_handles_missing_secondary():
    from app.runtime import _classify_rate_limit_windows

    session, week = _classify_rate_limit_windows({"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": None}, None)

    assert session is None
    assert week is not None
    assert week.percent_used == 0
    # No resetsAt -> no crash, just no label.
    assert week.resets_label is None


def test_parse_github_remote_handles_https_and_ssh_forms():
    from app.github_pr import parse_github_remote

    assert parse_github_remote("https://github.com/yna-team/ohso.git") == ("yna-team", "ohso")
    assert parse_github_remote("https://github.com/yna-team/ohso") == ("yna-team", "ohso")
    assert parse_github_remote("git@github.com:yna-team/ohso.git") == ("yna-team", "ohso")
    assert parse_github_remote("https://x-access-token:tok@github.com/yna-team/ohso.git") == ("yna-team", "ohso")
    # Non-GitHub remotes must not be treated as GitHub.
    assert parse_github_remote("https://gitlab.example.com/team/repo.git") is None
    assert parse_github_remote("/tmp/local/bare.git") is None


def test_approve_records_merge_outcome_event_and_still_succeeds_without_a_pull_request():
    # The approval itself must never fail just because the merge couldn't
    # happen (here: the test repo's origin is a local path, not GitHub).
    with TemporaryDirectory() as tmpdir:
        repo, _ = init_repo_with_remote_paths(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Merge On Approve", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Merge me", "prompt": "Do work", "model": "default"},
        ).json()

        approved = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert approved.status_code == 200
        assert approved.json()["status"] == "completed"

        events = client.get(f"/tasks/{task['id']}/events").json()
        merge_events = [
            e for e in events
            if e["payload_json"] and e["payload_json"].get("source") == "pull_request_merge"
        ]
        assert len(merge_events) == 1
        assert merge_events[0]["payload_json"]["ok"] is False


def test_approve_merges_pull_request_when_one_exists(monkeypatch):
    from app import main as main_module
    from app.github_pr import MergeResult

    calls: list[tuple[str, str]] = []

    async def fake_merge(workspace_path: str, branch: str, merge_method: str = "squash"):
        calls.append((workspace_path, branch))
        return MergeResult(True, "Merged pull request #42", 42, "https://github.com/o/r/pull/42")

    monkeypatch.setattr(main_module, "merge_pull_request_for_branch", fake_merge)

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Merge Success", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Merge me", "prompt": "Do work", "model": "default"},
        ).json()

        approved = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert approved.status_code == 200

        # Merged the task's own branch, in its own workspace.
        assert len(calls) == 1
        assert calls[0][0] == task["workspace_path"]
        assert calls[0][1] == task["workspace_ref"]

        events = client.get(f"/tasks/{task['id']}/events").json()
        merge_events = [
            e for e in events
            if e["payload_json"] and e["payload_json"].get("source") == "pull_request_merge"
        ]
        assert len(merge_events) == 1
        assert merge_events[0]["payload_json"]["ok"] is True
        assert merge_events[0]["payload_json"]["pr_number"] == 42


def test_approve_does_not_attempt_merge_for_plan_mode_tasks(monkeypatch):
    from app import main as main_module

    calls: list[str] = []

    async def fake_merge(workspace_path: str, branch: str, merge_method: str = "squash"):
        calls.append(branch)
        raise AssertionError("plan-mode tasks must not attempt a merge")

    monkeypatch.setattr(main_module, "merge_pull_request_for_branch", fake_merge)

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Plan No Merge", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={
                "project_id": project["id"],
                "title": "Plan it",
                "prompt": "Plan work",
                "model": "default",
                "execution_mode": "plan",
            },
        ).json()

        asyncio.run(asyncio.sleep(0.08))
        # Plan tasks complete without a result-approval step, so there is
        # nothing to approve -- the point is simply that no merge was tried.
        assert calls == []


def test_retry_marks_task_failed_when_starting_a_fresh_session_raises(monkeypatch):
    # Regression: retry_task moves the task to "starting" before opening the
    # runtime session. If that raised, the task used to be stranded in
    # "starting" with no session -- an ACTIVE status, so the UI showed it as
    # perpetually in progress and it could never be retried again.
    from app.main import orchestrator

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Retry Stuck", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Retry me", "prompt": "Do work", "model": "default"},
        ).json()

        # Get it into a retryable terminal state first.
        client.post(f"/tasks/{task['id']}/stop", json={"actor": "pytest"})

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            current.runtime_session_id = None
            db.add(current)
            db.commit()

        async def boom(request):
            raise RuntimeError("runtime refused to start")

        monkeypatch.setattr(orchestrator.adapter, "start_task", boom)

        response = client.post(f"/tasks/{task['id']}/retry", json={"actor": "pytest"})
        assert response.status_code == 409

        after = client.get(f"/tasks/{task['id']}").json()
        assert after["status"] == "failed"
        assert after["status"] not in ACTIVE_STATUSES_FOR_TEST


def test_reconcile_heals_active_task_left_without_a_runtime_session():
    # An active status is only ever set alongside opening a session, so an
    # active task with no session means the process died in between. Nothing
    # else can heal it: reconcile's main query requires a session and
    # reconcile_task_runtime_session early-returns without one.
    from app.main import orchestrator

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Orphan Heal", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Orphan", "prompt": "Do work", "model": "default"},
        ).json()

        with SessionLocal() as db:
            current = get_task(db, task["id"])
            current.status = "starting"
            current.runtime_session_id = None
            db.add(current)
            db.commit()

        healed = asyncio.run(orchestrator.reconcile_active_tasks())
        assert healed >= 1

        after = client.get(f"/tasks/{task['id']}").json()
        assert after["status"] == "failed"

        events = client.get(f"/tasks/{task['id']}/events").json()
        assert any(
            e["payload_json"] and e["payload_json"].get("reason") == "orphaned_active_task_no_session"
            for e in events
        )


def test_reconcile_leaves_healthy_active_tasks_alone():
    from app.main import orchestrator

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Healthy Active", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Healthy", "prompt": "Do work", "model": "default"},
        ).json()

        # Task has a live mock session and is waiting on approval -- must not
        # be swept up by the orphan healing.
        before = client.get(f"/tasks/{task['id']}").json()
        assert before["runtime_session_id"]

        asyncio.run(orchestrator.reconcile_active_tasks())

        after = client.get(f"/tasks/{task['id']}").json()
        assert after["status"] == before["status"]


def test_conversation_pr_info_attaches_each_prs_own_diff():
    # Regression: several PR/MR cards used to sit above a single flat file
    # list sourced from only the most-recently-mentioned PR/MR, with no way
    # to tell which files belonged to which card. Each PrInfoResponse now
    # carries its own `diff`, fetched by that PR/MR's own URL.
    from app.repository import add_conversation_message
    from app.schemas import AddConversationMessageRequest, TaskDiff
    from app.pr_info import PrInfo

    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Multi PR Project", "repo_path": str(repo), "default_branch": "main"},
        ).json()

        conversation = client.post(
            "/conversations",
            json={"project_id": project["id"], "title": "Multi PR conversation"},
        ).json()

        first_url = "https://github.com/acme/widgets/pull/11"
        second_url = "https://github.com/acme/widgets/pull/22"

        with SessionLocal() as db:
            add_conversation_message(
                db, conversation["id"], AddConversationMessageRequest(role="assistant", content=f"Opened PR: {first_url}")
            )
            add_conversation_message(
                db, conversation["id"], AddConversationMessageRequest(role="assistant", content=f"Opened a follow-up PR: {second_url}")
            )

        def fake_info(url: str) -> PrInfo:
            number = 11 if url == first_url else 22
            return PrInfo(
                platform="github",
                number=number,
                title=f"PR #{number}",
                description=None,
                state="open",
                url=url,
                source_branch="feature",
                target_branch="main",
                author="octocat",
                merged_at=None,
            )

        def fake_diff(url: str) -> TaskDiff:
            files = [f"file-{11 if url == first_url else 22}.py"]
            return TaskDiff(files_changed=files, summary="Updated 1 file(s).", raw_diff=None)

        async def fake_fetch_pr_or_mr_info(url: str):
            return fake_info(url)

        async def fake_fetch_pr_or_mr_diff(url: str):
            return fake_diff(url)

        import app.main as main_module

        original_info = main_module.fetch_pr_or_mr_info
        original_diff = main_module.fetch_pr_or_mr_diff
        main_module.fetch_pr_or_mr_info = fake_fetch_pr_or_mr_info
        main_module.fetch_pr_or_mr_diff = fake_fetch_pr_or_mr_diff
        try:
            response = client.get(f"/conversations/{conversation['id']}/pr-info")
        finally:
            main_module.fetch_pr_or_mr_info = original_info
            main_module.fetch_pr_or_mr_diff = original_diff

        assert response.status_code == 200
        body = response.json()
        # Most-recently-mentioned first.
        assert [item["url"] for item in body] == [second_url, first_url]
        assert body[0]["diff"]["files_changed"] == ["file-22.py"]
        assert body[1]["diff"]["files_changed"] == ["file-11.py"]
