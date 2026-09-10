from app.repository import build_workspace_ref, slugify


def test_build_workspace_ref_uses_project_name_as_prefix():
    ref = build_workspace_ref("Fix Canonical", project_name="ShipBae")
    assert ref.startswith("shipbae/fix-canonical-")
    # Trailing 4-char uuid suffix.
    suffix = ref.rsplit("-", 1)[-1]
    assert len(suffix) == 4


def test_build_workspace_ref_falls_back_to_task_without_project_name():
    ref = build_workspace_ref("Fix Canonical")
    assert ref.startswith("task/fix-canonical-")


def test_build_workspace_ref_slugifies_non_ascii_project_name():
    # A project name that slugifies to nothing (e.g. pure Korean text, which
    # slugify's `[^a-z0-9]+` pattern strips entirely) must still fall back to
    # a sane, non-empty prefix rather than producing "//<title>-<uuid>".
    ref = build_workspace_ref("Fix Canonical", project_name="한글프로젝트")
    assert ref.startswith("task/fix-canonical-")


def test_slugify_empty_or_symbol_only_falls_back_to_task():
    assert slugify("") == "task"
    assert slugify("!!!") == "task"


def test_resolve_pipeline_steps_and_attach_pipeline():
    import pytest
    from app.db import SessionLocal
    from app.repository import (
        attach_pipeline,
        create_project,
        create_project_pipeline,
        create_project_prompt,
        create_task,
        resolve_pipeline_steps,
    )
    from app.schemas import (
        CreateProjectPipelineRequest,
        CreateProjectPromptRequest,
        CreateProjectRequest,
        CreateTaskRequest,
    )

    with SessionLocal() as db:
        project = create_project(db, CreateProjectRequest(name="Pipeline Test Repo", repo_path="/tmp/pipeline-test"))
        p1 = create_project_prompt(db, project.id, CreateProjectPromptRequest(title="Step 1", content="Do step 1"))
        p2 = create_project_prompt(db, project.id, CreateProjectPromptRequest(title="Step 2", content="Do step 2"))
        pipeline = create_project_pipeline(
            db, project.id, CreateProjectPipelineRequest(name="Two Step Pipeline", prompt_ids=[p1.id, p2.id])
        )

        resolved_pipeline, steps = resolve_pipeline_steps(db, project.id, pipeline.id)
        assert resolved_pipeline.id == pipeline.id
        assert len(steps) == 2
        assert steps[0] == {"prompt_id": p1.id, "title": "Step 1", "content": "Do step 1"}
        assert steps[1] == {"prompt_id": p2.id, "title": "Step 2", "content": "Do step 2"}

        # Missing pipeline should raise ValueError
        with pytest.raises(ValueError, match="Pipeline not found"):
            resolve_pipeline_steps(db, project.id, "nonexistent-pipeline")

        # Test attach_pipeline
        task = create_task(
            db,
            CreateTaskRequest(
                project_id=project.id,
                title="Pipeline Task",
                prompt="Initial prompt",
                model="default",
            ),
        )
        updated_task = attach_pipeline(db, task, pipeline.id, pipeline.name, steps)
        assert updated_task.pipeline_id == pipeline.id
        assert updated_task.pipeline_name == "Two Step Pipeline"
        assert updated_task.pipeline_step_index == 0
        assert "Do step 1" in (updated_task.pipeline_steps_json or "")
