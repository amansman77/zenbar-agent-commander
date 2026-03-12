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
