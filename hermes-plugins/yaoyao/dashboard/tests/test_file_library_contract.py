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
