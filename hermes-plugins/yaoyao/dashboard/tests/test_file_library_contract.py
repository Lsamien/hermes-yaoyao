from __future__ import annotations

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

with mock.patch.object(poller, "start", return_value=None):
    import plugin_api  # noqa: E402


class FileLibraryContractTests(unittest.TestCase):
    def test_session_context_snapshot_is_profile_scoped_and_monotonic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = store.Store(Path(directory) / "first")
            second = store.Store(Path(directory) / "second")

            saved = first.upsert_session_context(
                "session-history-1",
                context_used=41_920,
                context_limit=256_000,
                context_percent=None,
                compressions=2,
                model="gpt-5.6",
                provider="openai-codex",
                observed_at=200,
            )
            stale = first.upsert_session_context(
                "session-history-1",
                context_used=12_000,
                context_limit=128_000,
                context_percent=9,
                compressions=0,
                model="old-model",
                provider="old-provider",
                observed_at=100,
            )

            self.assertEqual(saved["usedTokens"], 41_920)
            self.assertAlmostEqual(saved["percent"], 16.375)
            self.assertEqual(stale["usedTokens"], 41_920)
            self.assertEqual(stale["model"], "gpt-5.6")
            self.assertEqual(
                first.get_session_context("session-history-1"), stale
            )
            self.assertIsNone(second.get_session_context("session-history-1"))

    def test_session_context_routes_use_selected_profile_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = store.Store(Path(directory) / "profile")
            requested_profiles: list[str | None] = []

            def resolve(profile: str | None):
                requested_profiles.append(profile)
                return archive

            body = plugin_api.SessionContextSnapshotBody.model_validate(
                {
                    "usedTokens": 33_600,
                    "limitTokens": 256_000,
                    "percent": 13.125,
                    "compressions": 1,
                    "model": "claude-sonnet-4-6",
                    "provider": "anthropic",
                    "observedAt": 300,
                }
            )
            with mock.patch.object(plugin_api, "_store_for", side_effect=resolve):
                written = plugin_api.put_session_context(
                    "session-2", body, profile="planner"
                )
                loaded = plugin_api.get_session_context(
                    "session-2", profile="planner"
                )

            self.assertEqual(requested_profiles, ["planner", "planner"])
            self.assertEqual(
                written["snapshot"]["model"], "claude-sonnet-4-6"
            )
            self.assertEqual(loaded, written)
            paths = {getattr(route, "path", "") for route in plugin_api.router.routes}
            self.assertIn("/session-context/{session_id}", paths)

    def test_search_and_kind_filter_before_cursor_pagination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = store.Store(root / "library")
            old_cover = self._ingest(
                archive,
                root,
                display_name="cover-old.png",
                body=b"old-cover",
                message_id=1,
            )
            new_cover = self._ingest(
                archive,
                root,
                display_name="cover-new.png",
                body=b"new-cover",
                message_id=2,
            )
            self._ingest(
                archive,
                root,
                display_name="newest-notes.md",
                body=b"newest-notes",
                message_id=3,
            )

            first, next_cursor, total = archive.query_attachments(
                search="COVER",
                limit=1,
            )
            self.assertEqual([item["id"] for item in first], [new_cover])
            self.assertEqual(next_cursor, new_cover)
            self.assertEqual(total, 2)

            second, final_cursor, second_total = archive.query_attachments(
                search="cover",
                limit=1,
                cursor=next_cursor,
            )
            self.assertEqual([item["id"] for item in second], [old_cover])
            self.assertIsNone(final_cursor)
            self.assertEqual(second_total, 2)

            images, image_cursor, image_total = archive.query_attachments(
                kind="image",
                limit=10,
            )
            self.assertEqual(
                [item["displayName"] for item in images],
                ["cover-new.png", "cover-old.png"],
            )
            self.assertIsNone(image_cursor)
            self.assertEqual(image_total, 2)

    def test_profile_list_payload_and_download_route_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = store.Store(root / "yaoer-library")
            item_id = self._ingest(
                archive,
                root,
                display_name="cover.png",
                body=b"profile-cover",
                message_id=41,
            )
            other = store.Store(root / "other-library")
            self._ingest(
                other,
                root,
                display_name="other.txt",
                body=b"other-profile",
                message_id=42,
            )
            requested_profiles: list[str | None] = []

            def resolve(profile: str | None):
                requested_profiles.append(profile)
                return archive if profile == "yaoer" else other

            with mock.patch.object(plugin_api, "_store_for", side_effect=resolve):
                payload = plugin_api.list_files(
                    sender=None,
                    kind=None,
                    session_id=None,
                    search=None,
                    profile="yaoer",
                    limit=50,
                    cursor=None,
                )
                response = plugin_api.download_item(item_id, profile="yaoer")

            self.assertEqual(requested_profiles, ["yaoer", "yaoer"])
            self.assertEqual(payload["profile"], "yaoer")
            self.assertEqual(payload["total"], 1)
            self.assertIsNone(payload["nextCursor"])
            self.assertEqual([item["name"] for item in payload["items"]], ["cover.png"])
            self.assertEqual(
                payload["items"][0]["path"],
                f"yaoyao-file-library://archive/{item_id}?name=cover.png",
            )
            self.assertEqual(Path(response.path).read_bytes(), b"profile-cover")
            self.assertIn(
                "cover.png",
                response.headers.get("content-disposition", ""),
            )
            paths = {getattr(route, "path", "") for route in plugin_api.router.routes}
            self.assertIn("/files", paths)
            self.assertIn("/{item_id}/download", paths)

    @staticmethod
    def _ingest(
        archive: store.Store,
        root: Path,
        *,
        display_name: str,
        body: bytes,
        message_id: int,
    ) -> int:
        source = root / f"source-{message_id}"
        source.write_bytes(body)
        item_id = archive.ingest(
            str(source),
            sender="agent",
            source_kind="message",
            source_message_id=message_id,
            session_id="session-a",
            display_name=display_name,
            owner_profile="yaoer",
            discovered_at=message_id,
        )
        if item_id is None:
            raise AssertionError("fixture was not archived")
        return item_id


if __name__ == "__main__":
    unittest.main()
