from pathlib import Path

from app.codex_profiles import get_profile, list_profiles


def test_list_profiles_reads_profile_v2_config_files(tmp_path: Path):
    (tmp_path / "azure-sqlgen.config.toml").write_text(
        """
model = "gpt-5.5"
model_provider = "azure"
model_reasoning_effort = "medium"
personality = "pragmatic"
"""
    )
    (tmp_path / "careful.config.toml").write_text(
        """
approval_policy = "untrusted"
sandbox_mode = "read-only"
"""
    )
    # Non-profile files must be ignored.
    (tmp_path / "config.toml").write_text('model = "should-not-appear"\n')
    (tmp_path / "notes.txt").write_text("not a profile")

    profiles = list_profiles(tmp_path)

    ids = sorted(p.id for p in profiles)
    assert ids == ["azure-sqlgen", "careful"]

    azure = next(p for p in profiles if p.id == "azure-sqlgen")
    assert azure.model == "gpt-5.5"
    assert azure.model_provider == "azure"
    assert azure.reasoning_effort == "medium"
    assert azure.personality == "pragmatic"

    careful = next(p for p in profiles if p.id == "careful")
    assert careful.approval_policy == "untrusted"
    assert careful.sandbox_mode == "read-only"


def test_get_profile_returns_none_for_unknown_id(tmp_path: Path):
    (tmp_path / "azure-sqlgen.config.toml").write_text('model = "gpt-5.5"\n')
    assert get_profile("does-not-exist", tmp_path) is None
    assert get_profile(None, tmp_path) is None
    assert get_profile("azure-sqlgen", tmp_path) is not None


def test_list_profiles_returns_empty_for_missing_directory(tmp_path: Path):
    missing = tmp_path / "does-not-exist"
    assert list_profiles(missing) == []


def test_list_profiles_skips_unparseable_files(tmp_path: Path):
    (tmp_path / "broken.config.toml").write_text("this is not [valid toml")
    (tmp_path / "ok.config.toml").write_text('model = "gpt-5.5"\n')

    profiles = list_profiles(tmp_path)

    assert [p.id for p in profiles] == ["ok"]
