from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

os.environ["ZENBAR_RUNTIME_MODE"] = "mock"
os.environ["ZENBAR_DATABASE_URL"] = f"sqlite:///{Path(__file__).with_name('test_zenbar.db')}"

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402

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
    (repo / "README.md").write_text("hello\n")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True)
    return repo


def init_repo_with_remote(tmpdir: str) -> Path:
    bare = Path(tmpdir) / "remote.git"
    subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
    repo = init_repo(tmpdir)
    subprocess.run(["git", "remote", "add", "origin", str(bare)], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "push", "-u", "origin", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "remote", "set-head", "origin", "main"], cwd=repo, check=True, capture_output=True)
    return repo


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
            json={"project_id": project_id, "title": "Fix Canonical", "prompt": "Fix canonical tags"},
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
        assert "waiting_approval" in event_types


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
            json={"project_id": project_id, "title": "Plan Canonical", "prompt": "Create an implementation plan", "execution_mode": "plan"},
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
            json={"project_id": project["id"], "title": "Add Dashboard", "prompt": "Add dashboard"},
        ).json()

        response = client.post(f"/tasks/{task['id']}/approve", json={"actor": "pytest"})
        assert response.status_code == 200
        assert response.json()["status"] == "approved"


def test_invalid_retry_transition():
    with TemporaryDirectory() as tmpdir:
        repo = init_repo(tmpdir)
        project = client.post(
            "/projects",
            json={"name": "Sumi", "repo_path": str(repo), "default_branch": "main"},
        ).json()
        task = client.post(
            "/tasks",
            json={"project_id": project["id"], "title": "Initial task", "prompt": "Do work"},
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
            json={"project_id": project["id"], "title": "Plan task", "prompt": "Create a plan", "execution_mode": "plan"},
        )

        assert response.status_code == 200
        body = response.json()
        asyncio.run(asyncio.sleep(0.08))
        events = client.get(f"/tasks/{body['id']}/events")
        messages = [item["message"] for item in events.json()]
        assert any("attempting direct plan mode start" in message for message in messages)


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
