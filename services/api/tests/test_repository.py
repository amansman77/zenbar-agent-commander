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
