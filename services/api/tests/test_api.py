from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

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
        assert body["workspace_ref"].startswith("task/fix-canonical-")
        assert body["runtime_session_id"].startswith("mock-")
        assert Path(body["workspace_path"]).exists()

        asyncio.run(asyncio.sleep(0.08))

        events = client.get(f"/tasks/{body['id']}/events")
        assert events.status_code == 200
        event_types = [item["type"] for item in events.json()]
        assert "result_approval_requested" in event_types


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
        repo = init_repo(tmpdir)
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
        assert commit_body["branch"].startswith("task/")

        push = client.post(
            f"/tasks/{task['id']}/push",
            json={"actor": "pytest", "remote": "origin", "set_upstream": True},
        )
        assert push.status_code == 200
        push_body = push.json()
        assert push_body["ok"] is True
        branch = push_body["branch"]
        assert branch

        branches = subprocess.run(
            ["git", "branch", "--list", branch],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert branch in branches


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


def test_get_task_diff_uses_persisted_diff_when_runtime_session_is_stale():
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
        assert response.json()["summary"] == "Persisted diff"
        assert response.json()["files_changed"] == ["README.md"]


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
