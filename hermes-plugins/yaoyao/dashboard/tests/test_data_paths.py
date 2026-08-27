import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from data_paths import ensure_durable_data_root
from group_node_registry import PairedNodeRegistry


class DataPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_moves_legacy_tree_to_durable_plugin_data(self) -> None:
        legacy = self.root / "plugins" / "yaoyao" / "data"
        legacy.mkdir(parents=True)
        (legacy / "index.sqlite3").write_bytes(b"database")

        status = ensure_durable_data_root(self.root)

        self.assertTrue(status.ready)
        self.assertTrue(status.migrated)
        self.assertEqual(status.data_root, self.root / "plugin-data" / "yaoyao")
        self.assertEqual(
            (status.data_root / "index.sqlite3").read_bytes(), b"database"
        )
        self.assertFalse(legacy.exists())

    def test_refuses_to_merge_without_falling_back(self) -> None:
        legacy = self.root / "plugins" / "yaoyao" / "data"
        durable = self.root / "plugin-data" / "yaoyao"
        legacy.mkdir(parents=True)
        durable.mkdir(parents=True)
        (legacy / "legacy.db").write_bytes(b"legacy")
        (durable / "current.db").write_bytes(b"current")

        status = ensure_durable_data_root(self.root)

        self.assertFalse(status.ready)
        self.assertTrue(status.conflict)
        self.assertEqual(status.data_root, durable)
        self.assertTrue((legacy / "legacy.db").exists())
        self.assertTrue((durable / "current.db").exists())

    def test_fresh_profile_uses_durable_location_without_creating_it(self) -> None:
        status = ensure_durable_data_root(self.root)

        self.assertTrue(status.ready)
        self.assertFalse(status.migrated)
        self.assertEqual(status.data_root, self.root / "plugin-data" / "yaoyao")
        self.assertFalse(status.data_root.exists())

    def test_node_registry_uses_durable_data_root(self) -> None:
        with patch.dict(os.environ, {"HERMES_HOME": str(self.root)}):
            registry = PairedNodeRegistry.from_environment()

        self.assertEqual(registry.root, self.root / "plugin-data" / "yaoyao")
        self.assertTrue(registry.key_path.exists())
        self.assertFalse((self.root / "plugins" / "yaoyao" / "data").exists())

    def test_node_registry_keeps_durable_authority_during_legacy_conflict(
        self,
    ) -> None:
        durable = self.root / "plugin-data" / "yaoyao"
        legacy = self.root / "plugins" / "yaoyao" / "data"
        durable.mkdir(parents=True)
        legacy.mkdir(parents=True)
        (legacy / "stale.db").write_bytes(b"stale")

        with patch.dict(os.environ, {"HERMES_HOME": str(self.root)}):
            registry = PairedNodeRegistry.from_environment()

        self.assertEqual(registry.root, durable)
        self.assertTrue(registry.key_path.exists())
        self.assertFalse((legacy / "paired-group-nodes.key").exists())


if __name__ == "__main__":
    unittest.main()
