from pathlib import Path

from data_paths import ensure_durable_data_root


def test_moves_legacy_tree_to_durable_plugin_data(tmp_path: Path) -> None:
    legacy = tmp_path / "plugins" / "yaoyao" / "data"
    legacy.mkdir(parents=True)
    (legacy / "index.sqlite3").write_bytes(b"database")

    status = ensure_durable_data_root(tmp_path)

    assert status.ready is True
    assert status.migrated is True
    assert status.data_root == tmp_path / "plugin-data" / "yaoyao"
    assert (status.data_root / "index.sqlite3").read_bytes() == b"database"
    assert not legacy.exists()


def test_refuses_to_merge_two_nonempty_data_trees(tmp_path: Path) -> None:
    legacy = tmp_path / "plugins" / "yaoyao" / "data"
    durable = tmp_path / "plugin-data" / "yaoyao"
    legacy.mkdir(parents=True)
    durable.mkdir(parents=True)
    (legacy / "legacy.db").write_bytes(b"legacy")
    (durable / "current.db").write_bytes(b"current")

    status = ensure_durable_data_root(tmp_path)

    assert status.ready is False
    assert status.conflict is True
    assert status.data_root == legacy
    assert (legacy / "legacy.db").exists()
    assert (durable / "current.db").exists()


def test_fresh_profile_uses_durable_location_without_creating_it(tmp_path: Path) -> None:
    status = ensure_durable_data_root(tmp_path)

    assert status.ready is True
    assert status.migrated is False
    assert status.data_root == tmp_path / "plugin-data" / "yaoyao"
    assert not status.data_root.exists()
