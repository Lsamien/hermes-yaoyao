from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import poller  # noqa: E402
import store  # noqa: E402


class PollerContractTests(unittest.TestCase):
    def test_scans_file_references_from_every_session(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile_home = root / "profile"
            profile_home.mkdir()
            files = root / "files"
            files.mkdir()
            first = files / "first.docx"
            second = files / "second.xlsx"
            spaced = files / "third file.md"
            generated = files / "generated.txt"
            for index, path in enumerate((first, second, spaced, generated), 1):
                path.write_text(f"file {index}", encoding="utf-8")

            conn = sqlite3.connect(profile_home / "state.db")
            conn.execute(
                "CREATE TABLE messages ("
                "id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, "
                "content TEXT, tool_name TEXT)"
            )
            conn.executemany(
                "INSERT INTO messages(id, session_id, role, content, tool_name) "
                "VALUES(?,?,?,?,?)",
                (
                    (1, "session-a", "assistant", f"MEDIA:{first}", None),
                    (
                        2,
                        "session-b",
                        "user",
                        'GROUP_CONTEXT_JSON={"messages":[{"content":"'
                        f"MEDIA:{second}"
                        '","reasoning":"done"}]}',
                        None,
                    ),
                    (3, "session-c", "user", f'MEDIA:"{spaced}"', None),
                    (
                        4,
                        "session-d",
                        "tool",
                        json.dumps({"resolved_path": str(generated)}),
                        "write_file",
                    ),
                ),
            )
            conn.commit()
            conn.close()

            watcher = poller._ProfileWatcher("contract-test", profile_home)
            watcher.data_root = root / "library"
            watcher.store = store.Store(watcher.data_root)

            with mock.patch.object(poller, "BATCH_LIMIT", 2):
                for _ in range(3):
                    poller._poll_profile(watcher)

            items, _, _ = watcher.store.query_attachments(limit=20)
            self.assertEqual(
                {item["sessionId"] for item in items},
                {"session-a", "session-b", "session-c", "session-d"},
            )
            self.assertEqual(
                {item["displayName"] for item in items},
                {path.name for path in (first, second, spaced, generated)},
            )
            watcher.close()

    def test_scanner_version_replays_history_only_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = store.Store(Path(directory) / "library")
            archive.mark_processed(42)

            self.assertTrue(archive.prepare_scanner_version(7))
            self.assertEqual(archive.processed_waterline(), 0)

            archive.mark_processed(84)
            self.assertFalse(archive.prepare_scanner_version(7))
            self.assertEqual(archive.processed_waterline(), 84)

            self.assertTrue(archive.prepare_scanner_version(8))
            self.assertEqual(archive.processed_waterline(), 0)


if __name__ == "__main__":
    unittest.main()
