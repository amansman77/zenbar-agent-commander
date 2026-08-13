from pathlib import Path

import pytest

from app.codex_project_trust import (
    remove_project_trust_entry,
    remove_stale_project_trust_entries,
)


@pytest.fixture
def codex_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".codex"
    home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(home))
    return home


def _write_config(codex_home: Path, body: str) -> Path:
    config_path = codex_home / "config.toml"
    config_path.write_text(body)
    return config_path


def test_remove_project_trust_entry_removes_matching_entry(codex_home: Path, tmp_path: Path):
    live = tmp_path / "live-workspace"
    live.mkdir()
    config_path = _write_config(
        codex_home,
        f"""
model = "gpt-5.5"

[projects."{live}"]
trust_level = "trusted"

[projects."/some/other/path"]
trust_level = "trusted"
""",
    )

    removed = remove_project_trust_entry(str(live))

    assert removed is True
    text = config_path.read_text()
    assert str(live) not in text
    # Unrelated entries and top-level settings must survive untouched.
    assert '"/some/other/path"' in text
    assert 'model = "gpt-5.5"' in text


def test_remove_project_trust_entry_missing_config_is_noop(codex_home: Path):
    assert remove_project_trust_entry("/some/workspace") is False


def test_remove_project_trust_entry_no_matching_path_is_noop(codex_home: Path, tmp_path: Path):
    _write_config(
        codex_home,
        """
[projects."/some/other/path"]
trust_level = "trusted"
""",
    )

    assert remove_project_trust_entry(str(tmp_path / "does-not-match")) is False


def test_remove_project_trust_entry_none_path_is_noop(codex_home: Path):
    assert remove_project_trust_entry(None) is False


def test_remove_stale_project_trust_entries_removes_only_missing_paths(codex_home: Path, tmp_path: Path):
    live = tmp_path / "live-workspace"
    live.mkdir()
    stale = tmp_path / "deleted-workspace"
    config_path = _write_config(
        codex_home,
        f"""
model = "gpt-5.5"

[projects."{live}"]
trust_level = "trusted"

[projects."{stale}"]
trust_level = "trusted"
""",
    )

    removed = remove_stale_project_trust_entries()

    assert removed == [str(stale)]
    text = config_path.read_text()
    assert str(live) in text
    assert str(stale) not in text
    assert 'model = "gpt-5.5"' in text


def test_remove_stale_project_trust_entries_missing_config_returns_empty(codex_home: Path):
    assert remove_stale_project_trust_entries() == []
