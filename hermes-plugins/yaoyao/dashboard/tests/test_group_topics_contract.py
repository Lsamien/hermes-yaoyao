from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import UploadFile
from starlette.datastructures import Headers

DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import group_plugin_api  # noqa: E402

PROTOCOL = importlib.import_module(f"{group_plugin_api._LOCAL_PACKAGE}.group_protocol")
STORE_MODULE = importlib.import_module(f"{group_plugin_api._LOCAL_PACKAGE}.group_store")
ORCHESTRATOR = importlib.import_module(
    f"{group_plugin_api._LOCAL_PACKAGE}.group_orchestrator"
)
SETTINGS_TESTS = importlib.import_module("dashboard.tests.test_group_settings_contract")
GroupStore = STORE_MODULE.GroupStore


def new_id() -> str:
    return str(uuid.uuid4())


class GroupTopicsContractTests(unittest.TestCase):
    def test_protocol_and_router_advertise_topics(self) -> None:
        self.assertEqual(PROTOCOL.PROTOCOL_VERSION, 10)
        self.assertIn("topic.updated", PROTOCOL.EVENT_TYPES)
        self.assertIn("room.activity", PROTOCOL.EVENT_TYPES)
        request = PROTOCOL.SendMessageRequest.model_validate({
            "requestId": new_id(),
            "clientMessageId": new_id(),
            "topicId": new_id(),
            "content": "继续",
            "mentionAgentIds": [],
        })
        self.assertIsNotNone(request.topic_id)
        route_methods = {
            (route.path, tuple(sorted(route.methods or ())))
            for route in group_plugin_api.router.routes
            if hasattr(route, "methods")
        }
        self.assertIn(("/v1/rooms/{room_id}/topics", ("GET",)), route_methods)
        self.assertIn(
            ("/v1/rooms/{room_id}/topics/{topic_id}", ("PATCH",)),
            route_methods,
        )
        self.assertIn(
            ("/v1/rooms/{room_id}/topics/{topic_id}/read", ("PATCH",)),
            route_methods,
        )
        read_request = PROTOCOL.MarkTopicReadRequest.model_validate({
            "requestId": new_id(),
            "throughSeq": 12,
        })
        self.assertEqual(read_request.through_seq, 12)
        self.assertIn(
            ("/v1/rooms/{room_id}/uploads", ("POST",)), route_methods
        )

    def test_group_upload_persists_server_readable_attachment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": new_id(),
                    "name": "附件群",
                    "cwd": "",
                    "agents": [{"profile": "default"}],
                }
            )
            [agent] = room["agents"]
            room_id = room["id"]
            result = asyncio.run(
                group_plugin_api._persist_group_uploads(
                    room_id,
                    [
                        UploadFile(
                            filename="../photo.png",
                            file=BytesIO(b"fixture-image"),
                            headers=Headers({"content-type": "image/png"}),
                        )
                    ],
                    root=Path(directory) / "uploads",
                )
            )

            [uploaded] = result
            path = Path(uploaded["path"])
            self.assertEqual(
                path.parent,
                Path(directory).resolve() / "uploads" / room_id,
            )
            self.assertEqual(path.suffix, ".png")
            self.assertEqual(path.read_bytes(), b"fixture-image")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(uploaded["name"], "photo.png")
            self.assertEqual(uploaded["mimeType"], "image/png")
            self.assertEqual(uploaded["size"], len(b"fixture-image"))

            created = store.create_human_message(
                room_id,
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=new_id(),
                content=f"请查看图片\n\n![photo.png](<{path}>)",
                mention_agent_ids=[agent["id"]],
            )
            [run] = created["runs"]
            self.assertEqual(store.claim_next_runnable_run()["id"], run["id"])
            projection = store.read_run_projection(run["id"])
            prompt = ORCHESTRATOR.build_run_prompt(
                projection,
                store.get_room(room_id)["agents"],
            )
            self.assertIn(str(path), prompt)
            self.assertTrue(path.is_file())

    def test_group_upload_rejects_oversize_and_removes_partial_files(self) -> None:
        room_id = new_id()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(group_plugin_api, "_MAX_GROUP_UPLOAD_FILE_BYTES", 4),
        ):
            with self.assertRaises(group_plugin_api.GroupAPIError) as raised:
                asyncio.run(
                    group_plugin_api._persist_group_uploads(
                        room_id,
                        [
                            UploadFile(
                                filename="too-large.bin",
                                file=BytesIO(b"12345"),
                                headers=Headers(
                                    {"content-type": "application/octet-stream"}
                                ),
                            )
                        ],
                        root=Path(directory),
                    )
                )

            self.assertEqual(raised.exception.status_code, 413)
            self.assertEqual(
                [path for path in Path(directory).rglob("*") if path.is_file()],
                [],
            )

    def test_room_settings_still_update_without_changing_agents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "原房间",
                "cwd": "",
                "maxReplyRounds": 3,
                "agents": [{"profile": "default", "description": "保留职责"}],
            })
            before_agent = room["agents"][0]
            updated = store.update_room(
                room["id"],
                {
                    "requestId": new_id(),
                    "name": "新房间",
                    "maxReplyRounds": 5,
                },
            )
            self.assertEqual(updated["name"], "新房间")
            self.assertEqual(updated["maxReplyRounds"], 5)
            self.assertEqual(updated["agents"], [before_agent])

    def test_topic_title_update_is_idempotent_and_emits_topic_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "话题群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            created = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=new_id(),
                content="原始标题",
                mention_agent_ids=[],
            )
            topic_id = created["message"]["topicId"]
            request_id = new_id()
            before = store.latest_cursor()

            renamed = store.update_topic(
                room["id"],
                topic_id,
                {"requestId": request_id, "title": "  新的\n话题标题  "},
            )
            repeated = store.update_topic(
                room["id"],
                topic_id,
                {"requestId": request_id, "title": "  新的\n话题标题  "},
            )

            self.assertEqual(renamed["title"], "新的 话题标题")
            self.assertEqual(repeated, renamed)
            events = store.events_after(before, 10)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["eventType"], "topic.updated")
            self.assertEqual(events[0]["payload"]["title"], "新的 话题标题")

    def test_schema_v7_migrates_topic_read_position_without_data_loss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            store = GroupStore(path)
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "迁移群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            created = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=new_id(),
                content="保留消息",
                mention_agent_ids=[],
            )
            topic_id = created["message"]["topicId"]
            with store.connection() as connection:
                original_message_count = connection.execute(
                    "SELECT COUNT(*) FROM group_messages"
                ).fetchone()[0]
                original_latest_visible_seq = connection.execute(
                    """SELECT COALESCE(MAX(seq), 0) FROM group_messages
                    WHERE topic_id = ? AND visible = 1""",
                    (topic_id,),
                ).fetchone()[0]
            with store.write_transaction() as connection:
                columns = {
                    row["name"]
                    for row in connection.execute("PRAGMA table_info(group_topics)")
                }
                if "last_read_message_seq" in columns:
                    connection.execute(
                        "ALTER TABLE group_topics DROP COLUMN last_read_message_seq"
                    )
                connection.execute(
                    "UPDATE group_meta SET value = '7' WHERE key = 'schema_version'"
                )

            migrated = GroupStore(path)
            migrated.initialize()

            self.assertEqual(migrated.schema_version(), 12)
            with migrated.connection() as connection:
                topic = connection.execute(
                    "SELECT * FROM group_topics WHERE id = ?", (topic_id,)
                ).fetchone()
                message_count = connection.execute(
                    "SELECT COUNT(*) FROM group_messages"
                ).fetchone()[0]
            self.assertEqual(
                topic["last_read_message_seq"],
                original_latest_visible_seq,
            )
            self.assertEqual(message_count, original_message_count)
            self.assertEqual(migrated.room_activity(room["id"])["unreadCount"], 0)

    def test_room_activity_counts_active_runs_and_unread_agent_messages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "活动群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            agent = room["agents"][0]
            topic_id = new_id()
            created = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_id,
                content="用户问题",
                mention_agent_ids=[agent["id"]],
            )
            trigger = created["message"]
            run = created["runs"][0]
            with store.write_transaction() as connection:
                connection.execute(
                    "UPDATE group_agent_runs SET status = 'running' WHERE id = ?",
                    (run["id"],),
                )
                visible_ids = [new_id(), new_id()]
                for index, message_id in enumerate(visible_ids, start=2):
                    connection.execute(
                        """INSERT INTO group_messages
                        (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                         root_message_id, content, status, visible, created_at, updated_at)
                        VALUES (?, ?, ?, 'agent', ?, '夭夭', ?, ?, 'completed', 1, ?, ?)""",
                        (
                            message_id,
                            room["id"],
                            topic_id,
                            agent["id"],
                            trigger["rootMessageId"],
                            f"回复 {index}",
                            index,
                            index,
                        ),
                    )
                connection.execute(
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                     root_message_id, content, status, visible, created_at, updated_at)
                    VALUES (?, ?, ?, 'agent', ?, '夭夭', ?, '隐藏', 'completed', 0, 4, 4)""",
                    (
                        new_id(), room["id"], topic_id, agent["id"],
                        trigger["rootMessageId"],
                    ),
                )

            activity = store.room_activity(room["id"])

            self.assertEqual(activity["activeRunCount"], 1)
            self.assertEqual(activity["unreadCount"], 2)
            self.assertEqual(activity["lastMessage"]["id"], visible_ids[-1])

    def test_mark_topic_read_is_monotonic_idempotent_and_emits_activity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "已读群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            agent = room["agents"][0]
            topic_id = new_id()
            trigger = store.create_human_message(
                room["id"], request_id=new_id(), client_message_id=new_id(),
                topic_id=topic_id, content="问题", mention_agent_ids=[],
            )["message"]
            with store.write_transaction() as connection:
                connection.execute(
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                     root_message_id, content, status, visible, created_at, updated_at)
                    VALUES (?, ?, ?, 'agent', ?, '夭夭', ?, '回复', 'completed', 1, 2, 2)""",
                    (
                        new_id(), room["id"], topic_id, agent["id"],
                        trigger["rootMessageId"],
                    ),
                )
                through_seq = connection.execute(
                    "SELECT MAX(seq) FROM group_messages WHERE topic_id = ?",
                    (topic_id,),
                ).fetchone()[0]
            request_id = new_id()
            before = store.latest_cursor()

            first = store.mark_topic_read(
                room["id"], topic_id,
                {"requestId": request_id, "throughSeq": through_seq},
            )
            repeated = store.mark_topic_read(
                room["id"], topic_id,
                {"requestId": request_id, "throughSeq": through_seq},
            )
            stale = store.mark_topic_read(
                room["id"], topic_id,
                {"requestId": new_id(), "throughSeq": through_seq - 1},
            )

            self.assertEqual(first, repeated)
            self.assertEqual(first["topic"]["lastReadMessageSeq"], through_seq)
            self.assertEqual(stale["room"]["unreadCount"], 0)
            events = store.events_after(before, 10)
            self.assertEqual(
                [event["eventType"] for event in events],
                ["topic.updated", "room.activity"],
            )
            with self.assertRaises(ValueError):
                store.mark_topic_read(
                    room["id"], topic_id,
                    {"requestId": new_id(), "throughSeq": through_seq + 100},
                )

    def test_topics_page_filter_compatibility_and_event_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "话题群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            topic_a, topic_b = new_id(), new_id()
            with self.assertRaises(STORE_MODULE.GroupNotFoundError):
                store.list_messages(room["id"], topic_id=new_id())
            before = store.latest_cursor()
            first = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_a,
                content="第一个话题",
                mention_agent_ids=[],
            )
            events = store.events_after(before, 10)
            self.assertEqual(
                [event["eventType"] for event in events],
                [
                    "message.upsert",
                    "topic.updated",
                    "room.activity",
                    "message.upsert",
                    "topic.updated",
                    "run.updated",
                    "room.activity",
                ],
            )
            self.assertEqual(events[0]["payload"]["topicId"], topic_a)
            self.assertEqual(
                set(events[1]["payload"]),
                {
                    "id",
                    "roomId",
                    "title",
                    "preview",
                    "messageCount",
                    "unreadCount",
                    "latestMessageSeq",
                    "lastReadMessageSeq",
                    "archived",
                    "pinned",
                    "createdAt",
                    "updatedAt",
                },
            )
            self.assertEqual(events[1]["payload"]["id"], topic_a)
            self.assertEqual(events[2]["payload"]["roomId"], room["id"])
            self.assertEqual(events[2]["payload"]["activeRunCount"], 0)
            self.assertEqual(events[-1]["payload"]["activeRunCount"], 1)

            second = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_a,
                content="第一个话题的后续",
                mention_agent_ids=[],
            )
            store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_b,
                content="第二个话题",
                mention_agent_ids=[],
            )
            compatibility_first = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                content="旧客户端消息",
                mention_agent_ids=[],
            )
            compatibility_second = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                content="旧客户端继续",
                mention_agent_ids=[],
            )
            self.assertEqual(
                compatibility_first["message"]["topicId"],
                compatibility_second["message"]["topicId"],
            )
            self.assertEqual(
                compatibility_first["message"]["topicId"],
                store._compatibility_topic_id(room["id"]),
            )

            topic_a_messages = store.list_messages(room["id"], topic_id=topic_a)
            self.assertEqual(
                [
                    message["id"]
                    for message in topic_a_messages
                    if message["senderKind"] == "human"
                ],
                [first["message"]["id"], second["message"]["id"]],
            )
            self.assertEqual(
                sum(
                    message["senderKind"] == "human"
                    for message in store.list_messages(room["id"])
                ),
                5,
            )
            page_one = store.list_topics(room["id"], limit=2, cursor=None)
            page_two = store.list_topics(
                room["id"], limit=2, cursor=page_one.next_cursor
            )
            self.assertIsNotNone(page_one.next_cursor)
            summaries = [*page_one.items, *page_two.items]
            self.assertEqual(len(summaries), 3)
            summary_a = next(item for item in summaries if item["id"] == topic_a)
            self.assertEqual(summary_a["title"], "第一个话题")
            self.assertEqual(summary_a["preview"], "第一个话题的后续")
            self.assertEqual(summary_a["messageCount"], 4)

            other_room = store.create_room({
                "requestId": new_id(),
                "name": "另一个群",
                "cwd": "",
                "agents": [{"profile": "other"}],
            })
            with self.assertRaisesRegex(ValueError, "does not belong to room"):
                store.list_topics(
                    other_room["id"], limit=2, cursor=page_one.next_cursor
                )
            with self.assertRaises(STORE_MODULE.GroupConflictError):
                store.create_human_message(
                    other_room["id"],
                    request_id=new_id(),
                    client_message_id=new_id(),
                    topic_id=topic_a,
                    content="错误归属",
                    mention_agent_ids=[],
                )

    def test_topic_context_watermarks_room_session_and_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "上下文群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            [agent] = room["agents"]
            topic_a, topic_b = new_id(), new_id()

            run_a = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_a,
                content="A-1",
                mention_agent_ids=[agent["id"]],
            )["runs"][0]
            self.assertEqual(store.claim_next_runnable_run()["id"], run_a["id"])
            projection_a = store.read_run_projection(run_a["id"])
            self.assertEqual(
                [message["content"] for message in projection_a["messages"]], ["A-1"]
            )
            prompt_a = ORCHESTRATOR.build_run_prompt(
                projection_a, store.get_room(room["id"])["agents"]
            )
            envelope_a = json.loads(prompt_a.rsplit("GROUP_CONTEXT_JSON=", 1)[1])
            self.assertEqual(envelope_a["run"]["topicId"], topic_a)
            self._submit_and_settle(
                store, projection_a, runtime="runtime-a", stored="stored-room"
            )

            run_b = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_b,
                content="B-1",
                mention_agent_ids=[agent["id"]],
            )["runs"][0]
            self.assertEqual(store.claim_next_runnable_run()["id"], run_b["id"])
            projection_b = store.read_run_projection(run_b["id"])
            self.assertFalse(projection_b["initial"])
            self.assertEqual(projection_b["agent"]["storedSessionId"], "stored-room")
            self.assertEqual(
                [message["content"] for message in projection_b["messages"]], ["B-1"]
            )
            prompt_b = ORCHESTRATOR.build_run_prompt(
                projection_b, store.get_room(room["id"])["agents"]
            )
            envelope_b = json.loads(prompt_b.rsplit("GROUP_CONTEXT_JSON=", 1)[1])
            self.assertEqual(envelope_b["run"]["topicId"], topic_b)
            self.assertNotEqual(
                envelope_a["run"]["topicId"], envelope_b["run"]["topicId"]
            )
            self._submit_and_settle(
                store, projection_b, runtime="runtime-b", stored="stored-room"
            )

            run_a2 = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_a,
                content="A-2",
                mention_agent_ids=[agent["id"]],
            )["runs"][0]
            self.assertEqual(store.claim_next_runnable_run()["id"], run_a2["id"])
            incremental = store.read_run_projection(run_a2["id"])
            self.assertEqual(
                [message["content"] for message in incremental["messages"]], ["A-2"]
            )
            self.assertTrue(
                store.prepare_run_session_configuration(
                    run_a2["id"],
                    {
                        "model": None,
                        "provider": None,
                        "reasoning_effort": None,
                        "fast": None,
                    },
                )
            )
            rebuilt = store.read_run_projection(run_a2["id"])
            self.assertTrue(rebuilt["initial"])
            rebuilt_contents = [message["content"] for message in rebuilt["messages"]]
            self.assertEqual(rebuilt_contents, ["A-1", "A-2"])
            self.assertNotIn("B-1", rebuilt_contents)
            with store.connection() as connection:
                watermarks = connection.execute(
                    """SELECT topic_id, last_context_message_seq
                    FROM group_agent_topic_state WHERE agent_id = ?""",
                    (agent["id"],),
                ).fetchall()
            self.assertEqual(
                {
                    row["topic_id"]: row["last_context_message_seq"]
                    for row in watermarks
                },
                {topic_a: 0, topic_b: 0},
            )

    def test_cross_topic_runs_interactions_and_cascades_keep_topic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "并发群",
                "cwd": "",
                "agents": [
                    {"profile": "one", "displayName": "一号"},
                    {"profile": "two", "displayName": "二号"},
                ],
            })
            first_agent, second_agent = room["agents"]
            topic_a, topic_b = new_id(), new_id()
            first_run = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_a,
                content="请一号回复",
                mention_agent_ids=[first_agent["id"]],
            )["runs"][0]
            second_run = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_b,
                content="请二号回复",
                mention_agent_ids=[second_agent["id"]],
            )["runs"][0]
            claimed = {
                store.claim_next_runnable_run()["id"],
                store.claim_next_runnable_run()["id"],
            }
            self.assertEqual(claimed, {first_run["id"], second_run["id"]})
            interaction = store.create_interaction(
                "approval-topic-test",
                first_run["id"],
                kind="approval",
                payload={"tool": "test"},
            )
            self.assertEqual(interaction["topicId"], topic_a)

            store.transition_run(first_run["id"], "running")
            store.upsert_agent_message(
                first_run["id"],
                content="@二号 继续",
                reasoning="",
                tool_state=[],
                status="completed",
            )
            store.transition_run(first_run["id"], "completed")
            cascade = store.enqueue_cascade_runs(
                first_run["id"], agent_ids=[second_agent["id"]], warnings=[]
            )
            [cascade_run] = cascade["runs"]
            self.assertEqual(cascade_run["topicId"], topic_a)

    def test_v2_stored_default_session_preserves_session_and_watermark(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            room_id, agent_id, topic_id = self._create_legacy_database(
                path, version=2, stored_session_id="stored-v2"
            )
            store = GroupStore(path)
            store.initialize()
            with store.connection() as connection:
                agent = connection.execute(
                    "SELECT * FROM group_agents WHERE id = ?", (agent_id,)
                ).fetchone()
            self.assertEqual(
                agent["session_config_json"],
                '{"fast":null,"model":null,"provider":null,"reasoning_effort":null}',
            )
            run = self._claim_legacy_topic_continuation(
                store, room_id, agent_id, topic_id
            )
            self.assertFalse(
                store.prepare_run_session_configuration(
                    run["id"], self._default_session_configuration()
                )
            )
            with store.connection() as connection:
                refreshed = connection.execute(
                    "SELECT * FROM group_agents WHERE id = ?", (agent_id,)
                ).fetchone()
                state = connection.execute(
                    """SELECT * FROM group_agent_topic_state
                    WHERE agent_id = ? AND topic_id = ?""",
                    (agent_id, topic_id),
                ).fetchone()
            self.assertEqual(refreshed["stored_session_id"], "stored-v2")
            self.assertEqual(state["last_context_message_seq"], 1)

    def test_v2_without_stored_session_rotates_default_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            room_id, agent_id, topic_id = self._create_legacy_database(
                path, version=2, stored_session_id=None
            )
            store = GroupStore(path)
            store.initialize()
            with store.connection() as connection:
                agent = connection.execute(
                    "SELECT * FROM group_agents WHERE id = ?", (agent_id,)
                ).fetchone()
            self.assertIsNone(agent["session_config_json"])
            run = self._claim_legacy_topic_continuation(
                store, room_id, agent_id, topic_id
            )
            self.assertTrue(
                store.prepare_run_session_configuration(
                    run["id"], self._default_session_configuration()
                )
            )
            with store.connection() as connection:
                state = connection.execute(
                    """SELECT * FROM group_agent_topic_state
                    WHERE agent_id = ? AND topic_id = ?""",
                    (agent_id, topic_id),
                ).fetchone()
            self.assertEqual(state["last_context_message_seq"], 0)

    def test_v3_dirty_null_session_configuration_still_rotates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            room_id, agent_id, topic_id = self._create_legacy_database(
                path, version=3, stored_session_id="stored-dirty-v3"
            )
            store = GroupStore(path)
            store.initialize()
            with store.connection() as connection:
                agent = connection.execute(
                    "SELECT * FROM group_agents WHERE id = ?", (agent_id,)
                ).fetchone()
            self.assertIsNone(agent["session_config_json"])
            run = self._claim_legacy_topic_continuation(
                store, room_id, agent_id, topic_id
            )
            self.assertTrue(
                store.prepare_run_session_configuration(
                    run["id"], self._default_session_configuration()
                )
            )
            self.assertIsNone(store.get_room(room_id)["agents"][0]["storedSessionId"])

    def test_legacy_agent_status_and_failed_interaction_replay_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "兼容群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            [agent] = room["agents"]
            topic_id = new_id()
            run = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_id,
                content="需要审批",
                mention_agent_ids=[agent["id"]],
            )["runs"][0]
            claimed = store.claim_next_runnable_run()
            self.assertEqual(claimed["id"], run["id"])
            status_events = [
                event
                for event in store.events_after(0, 100)
                if event["eventType"] == "agent.status"
            ]
            self.assertTrue(status_events)
            self.assertEqual(
                set(status_events[-1]["payload"]),
                {"roomId", "agentId", "status", "runId"},
            )
            store.bind_run_runtime(run["id"], "runtime-legacy-shape")
            interaction = store.create_interaction(
                "approval-legacy-shape",
                run["id"],
                kind="approval",
                payload={"choices": ["once"]},
            )
            response_request = new_id()
            response = {"choice": "once", "permanent": False}
            store.begin_interaction_response(
                room["id"],
                interaction["id"],
                request_id=response_request,
                kind="approval",
                response=response,
            )
            failed = store.fail_interaction_response(
                response_request,
                reason="Gateway outcome unknown",
                uncertain=True,
            )
            self.assertNotIn("topicId", failed["run"])
            self.assertEqual(
                set(failed["run"]),
                {
                    "id",
                    "roomId",
                    "agentId",
                    "triggerMessageId",
                    "responseMessageId",
                    "rootMessageId",
                    "depth",
                    "replyMode",
                    "status",
                    "runtimeSessionId",
                    "error",
                    "createdAt",
                    "updatedAt",
                },
            )
            replay = store.begin_interaction_response(
                room["id"],
                interaction["id"],
                request_id=response_request,
                kind="approval",
                response=response,
            )
            self.assertEqual(replay, failed)
            run_events = [
                event
                for event in store.events_after(0, 200)
                if event["eventType"] == "run.updated"
            ]
            self.assertEqual(run_events[-1]["payload"]["topicId"], topic_id)

    def test_composite_topic_foreign_keys_reject_cross_room_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            first_room = store.create_room({
                "requestId": new_id(),
                "name": "房间一",
                "cwd": "",
                "agents": [{"profile": "one"}],
            })
            second_room = store.create_room({
                "requestId": new_id(),
                "name": "房间二",
                "cwd": "",
                "agents": [{"profile": "two"}],
            })
            topic_id = new_id()
            first_message = store.create_human_message(
                first_room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=topic_id,
                content="归属房间一",
                mention_agent_ids=[],
            )["message"]
            [second_agent] = second_room["agents"]
            invalid_statements = (
                (
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                     root_message_id, reply_to_message_id, client_message_id,
                     content, reasoning, tool_state_json, status, error, visible,
                     created_at, updated_at)
                    VALUES (?, ?, ?, 'human', 'human', '你', ?, NULL, ?, '错误',
                            '', '[]', 'completed', '', 1, 1, 1)""",
                    (
                        new_id(),
                        second_room["id"],
                        topic_id,
                        new_id(),
                        new_id(),
                    ),
                ),
                (
                    """INSERT INTO group_agent_runs
                    (id, room_id, topic_id, agent_id, trigger_message_id,
                     response_message_id, root_message_id, depth, reply_mode,
                     status, runtime_session_id, error, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'mentioned', 'completed',
                            NULL, '', 1, 1)""",
                    (
                        new_id(),
                        second_room["id"],
                        topic_id,
                        second_agent["id"],
                        first_message["id"],
                        first_message["id"],
                        first_message["rootMessageId"],
                    ),
                ),
                (
                    """INSERT INTO group_interactions
                    (id, room_id, topic_id, agent_id, run_id, kind, payload_json,
                     status, created_at, resolved_at)
                    VALUES (?, ?, ?, ?, ?, 'approval', '{}', 'pending', 1, NULL)""",
                    (
                        "cross-room-interaction",
                        second_room["id"],
                        topic_id,
                        second_agent["id"],
                        new_id(),
                    ),
                ),
            )
            for statement, parameters in invalid_statements:
                with self.subTest(table=statement.split()[2]):
                    with self.assertRaises(sqlite3.IntegrityError):
                        with store.write_transaction() as connection:
                            connection.execute(statement, parameters)

    def test_v3_migration_topic_order_ignores_newer_hidden_messages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            room_id, _agent_id, first_topic = self._create_legacy_database(
                path, version=3, stored_session_id=None
            )
            second_topic, hidden_topic = new_id(), new_id()
            connection = sqlite3.connect(path)
            connection.execute(
                """UPDATE group_messages
                SET visible = 1, created_at = 1, updated_at = 10
                WHERE root_message_id = ?""",
                (first_topic,),
            )
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning,
                 tool_state_json, status, error, visible, created_at, updated_at)
                VALUES (?, ?, 'agent', 'hidden', '隐藏', ?, NULL, NULL,
                        '隐藏更新', '', '[]', 'completed', '', 0, 2, 100)""",
                (new_id(), room_id, first_topic),
            )
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning,
                 tool_state_json, status, error, visible, created_at, updated_at)
                VALUES (?, ?, 'human', 'human', '你', ?, NULL, ?,
                        '第二可见话题', '', '[]', 'completed', '', 1, 3, 50)""",
                (second_topic, room_id, second_topic, new_id()),
            )
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning,
                 tool_state_json, status, error, visible, created_at, updated_at)
                VALUES (?, ?, 'agent', 'hidden', '隐藏', ?, NULL, NULL,
                        '仅隐藏话题', '', '[]', 'completed', '', 0, 4, 75)""",
                (hidden_topic, room_id, hidden_topic),
            )
            connection.commit()
            connection.close()

            store = GroupStore(path)
            store.initialize()
            topics = store.list_topics(room_id, limit=10, cursor=None).items
            self.assertEqual(
                [topic["id"] for topic in topics],
                [hidden_topic, second_topic, first_topic],
            )
            self.assertEqual(
                {topic["id"]: topic["updatedAt"] for topic in topics},
                {hidden_topic: 75, second_topic: 50, first_topic: 10},
            )

    def test_v3_migration_rejects_orphan_run_messages_and_interactions(self) -> None:
        for column in ("trigger_message_id", "response_message_id"):
            with (
                self.subTest(orphan=column),
                tempfile.TemporaryDirectory() as directory,
            ):
                path = Path(directory) / "group.db"
                self._create_legacy_database(path, version=3, stored_session_id=None)
                connection = sqlite3.connect(path)
                connection.execute(
                    f"UPDATE group_agent_runs SET {column} = ?", (new_id(),)
                )
                connection.commit()
                connection.close()
                with self.assertRaisesRegex(
                    STORE_MODULE.GroupStoreError, "run messages are orphaned"
                ):
                    GroupStore(path).initialize()
                self._assert_legacy_schema_rolled_back(path)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            room_id, agent_id, _topic_id = self._create_legacy_database(
                path, version=3, stored_session_id=None
            )
            connection = sqlite3.connect(path)
            connection.execute(
                """INSERT INTO group_interactions
                (id, room_id, agent_id, run_id, kind, payload_json, status,
                 created_at, resolved_at)
                VALUES ('orphan-interaction', ?, ?, ?, 'approval', '{}',
                        'pending', 1, NULL)""",
                (room_id, agent_id, new_id()),
            )
            connection.commit()
            connection.close()
            with self.assertRaisesRegex(
                STORE_MODULE.GroupStoreError, "interaction run is orphaned"
            ):
                GroupStore(path).initialize()
            self._assert_legacy_schema_rolled_back(path)

    def test_v4_validation_rejects_missing_run_trigger_or_response(self) -> None:
        for column in ("trigger_message_id", "response_message_id"):
            with (
                self.subTest(orphan=column),
                tempfile.TemporaryDirectory() as directory,
            ):
                path = Path(directory) / "group.db"
                store = GroupStore(path)
                store.initialize()
                room = store.create_room({
                    "requestId": new_id(),
                    "name": "损坏群",
                    "cwd": "",
                    "agents": [{"profile": "default"}],
                })
                [agent] = room["agents"]
                topic_id = new_id()
                message = store.create_human_message(
                    room["id"],
                    request_id=new_id(),
                    client_message_id=new_id(),
                    topic_id=topic_id,
                    content="有效消息",
                    mention_agent_ids=[],
                )["message"]
                trigger_id = (
                    new_id() if column == "trigger_message_id" else message["id"]
                )
                response_id = (
                    new_id() if column == "response_message_id" else message["id"]
                )
                with store.connection() as connection:
                    connection.execute(
                        """INSERT INTO group_agent_runs
                        (id, room_id, topic_id, agent_id, trigger_message_id,
                         response_message_id, root_message_id, depth, reply_mode,
                         status, runtime_session_id, error, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'mentioned', 'completed',
                                NULL, '', 1, 1)""",
                        (
                            new_id(),
                            room["id"],
                            topic_id,
                            agent["id"],
                            trigger_id,
                            response_id,
                            message["rootMessageId"],
                        ),
                    )
                with self.assertRaisesRegex(
                    STORE_MODULE.GroupStoreError, "stored values are corrupt"
                ):
                    GroupStore(path).initialize()

    def test_early_v4_draft_repairs_losslessly_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            store = GroupStore(path)
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "早期 v4 群",
                "cwd": "",
                "agents": [{"profile": "default", "description": "保留设置"}],
            })
            [agent] = room["agents"]
            visible_topic, hidden_topic = new_id(), new_id()
            created = store.create_human_message(
                room["id"],
                request_id=new_id(),
                client_message_id=new_id(),
                topic_id=visible_topic,
                content="可见话题",
                mention_agent_ids=[agent["id"]],
            )
            [run] = created["runs"]
            self.assertEqual(store.claim_next_runnable_run()["id"], run["id"])
            store.bind_run_runtime(run["id"], "runtime-early-v4")
            interaction = store.create_interaction(
                "approval-early-v4",
                run["id"],
                kind="approval",
                payload={"choices": ["once"]},
            )
            failed_request = new_id()
            with store.write_transaction() as connection:
                connection.execute(
                    """UPDATE group_messages SET created_at = 1, updated_at = 10
                    WHERE topic_id = ?""",
                    (visible_topic,),
                )
                connection.execute(
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                     root_message_id, reply_to_message_id, client_message_id,
                     content, reasoning, tool_state_json, status, error, visible,
                     created_at, updated_at)
                    VALUES (?, ?, ?, 'agent', ?, '隐藏', ?, NULL, NULL,
                            '隐藏更新', '', '[]', 'completed', '', 0, 2, 100)""",
                    (
                        new_id(),
                        room["id"],
                        visible_topic,
                        agent["id"],
                        created["message"]["rootMessageId"],
                    ),
                )
                store._ensure_topic(
                    connection, room["id"], hidden_topic, "仅隐藏话题", 4
                )
                connection.execute(
                    """INSERT INTO group_messages
                    (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                     root_message_id, reply_to_message_id, client_message_id,
                     content, reasoning, tool_state_json, status, error, visible,
                     created_at, updated_at)
                    VALUES (?, ?, ?, 'agent', ?, '隐藏', ?, NULL, NULL,
                            '仅隐藏消息', '', '[]', 'completed', '', 0, 4, 75)""",
                    (hidden_topic, room["id"], hidden_topic, agent["id"], hidden_topic),
                )
                connection.execute("UPDATE group_topics SET updated_at = 999")
                status_events = connection.execute(
                    """SELECT cursor, payload_json FROM group_events
                    WHERE event_type = 'agent.status'"""
                ).fetchall()
                for event in status_events:
                    payload = json.loads(event["payload_json"])
                    payload["topicId"] = visible_topic
                    connection.execute(
                        "UPDATE group_events SET payload_json = ? WHERE cursor = ?",
                        (GroupStore._canonical_json(payload), event["cursor"]),
                    )
                failed_run = store._run_wire(store._run_row(connection, run["id"]))
                connection.execute(
                    """INSERT INTO group_idempotency
                    (request_id, operation, request_hash, response_json, created_at)
                    VALUES (?, ?, 'early-v4-failed-hash', ?, 5)""",
                    (
                        failed_request,
                        f"interaction.approval.response:{interaction['id']}",
                        GroupStore._canonical_json({
                            "state": "failed",
                            "reason": "early failure",
                            "runtimeSessionIds": ["runtime-early-v4"],
                            "run": failed_run,
                        }),
                    ),
                )

            with store.connection() as connection:
                expected_room = dict(
                    connection.execute(
                        "SELECT * FROM group_rooms WHERE id = ?", (room["id"],)
                    ).fetchone()
                )
                expected_agent = dict(
                    connection.execute(
                        "SELECT * FROM group_agents WHERE id = ?", (agent["id"],)
                    ).fetchone()
                )
                expected_counts = {
                    table: connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                    for table in (
                        "group_messages",
                        "group_agent_runs",
                        "group_interactions",
                        "group_topics",
                        "group_agent_topic_state",
                    )
                }
                expected_states = [
                    tuple(row)
                    for row in connection.execute(
                        """SELECT * FROM group_agent_topic_state
                        ORDER BY agent_id, topic_id"""
                    )
                ]
                self._downgrade_to_early_v4(connection)
                self.assertEqual(
                    {
                        table: GroupStore._topic_foreign_key_kind(connection, table)
                        for table in (
                            "group_messages",
                            "group_agent_runs",
                            "group_interactions",
                        )
                    },
                    {
                        "group_messages": "early",
                        "group_agent_runs": "early",
                        "group_interactions": "early",
                    },
                )

            repaired = GroupStore(path)
            repaired.initialize()
            with repaired.connection() as connection:
                self.assertEqual(
                    {
                        table: GroupStore._topic_foreign_key_kind(connection, table)
                        for table in (
                            "group_messages",
                            "group_agent_runs",
                            "group_interactions",
                        )
                    },
                    {
                        "group_messages": "final",
                        "group_agent_runs": "final",
                        "group_interactions": "final",
                    },
                )
                self.assertEqual(
                    dict(
                        connection.execute(
                            "SELECT * FROM group_rooms WHERE id = ?", (room["id"],)
                        ).fetchone()
                    ),
                    expected_room,
                )
                self.assertEqual(
                    dict(
                        connection.execute(
                            "SELECT * FROM group_agents WHERE id = ?", (agent["id"],)
                        ).fetchone()
                    ),
                    expected_agent,
                )
                actual_counts = {
                    table: connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                    for table in expected_counts
                }
                self.assertEqual(actual_counts, expected_counts)
                max_message_seq = connection.execute(
                    "SELECT MAX(seq) FROM group_messages"
                ).fetchone()[0]
                message_sequence = connection.execute(
                    "SELECT seq FROM sqlite_sequence WHERE name = 'group_messages'"
                ).fetchone()[0]
                self.assertEqual(message_sequence, max_message_seq)
                self.assertEqual(
                    [
                        tuple(row)
                        for row in connection.execute(
                            """SELECT * FROM group_agent_topic_state
                            ORDER BY agent_id, topic_id"""
                        )
                    ],
                    expected_states,
                )
                topics = {
                    row["id"]: dict(row)
                    for row in connection.execute(
                        "SELECT * FROM group_topics ORDER BY id"
                    )
                }
                self.assertEqual(topics[visible_topic]["updated_at"], 10)
                self.assertEqual(topics[hidden_topic]["updated_at"], 75)
                for event in connection.execute(
                    """SELECT payload_json FROM group_events
                    WHERE event_type = 'agent.status'"""
                ):
                    self.assertNotIn("topicId", json.loads(event["payload_json"]))
                failed = json.loads(
                    connection.execute(
                        """SELECT response_json FROM group_idempotency
                        WHERE request_id = ?""",
                        (failed_request,),
                    ).fetchone()[0]
                )
                self.assertNotIn("topicId", failed["run"])
                first_snapshot = self._repair_snapshot(connection)

            repaired.initialize()
            with repaired.connection() as connection:
                self.assertEqual(self._repair_snapshot(connection), first_snapshot)

    def test_v3_migration_preserves_room_agent_and_rewrites_topic_wires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            SETTINGS_TESTS.GroupSettingsContractTests._create_v1_database(path)
            connection = sqlite3.connect(path)
            connection.row_factory = sqlite3.Row
            GroupStore._migrate_v1_to_v2(connection)
            GroupStore._migrate_v2_to_v3(connection)
            room_id = connection.execute("SELECT id FROM group_rooms").fetchone()[0]
            agent_id = connection.execute("SELECT id FROM group_agents").fetchone()[0]
            first_message = connection.execute(
                "SELECT * FROM group_messages ORDER BY seq LIMIT 1"
            ).fetchone()
            connection.execute(
                """UPDATE group_rooms SET name = '保留群', max_reply_rounds = 7,
                archived = 1 WHERE id = ?""",
                (room_id,),
            )
            connection.execute(
                """UPDATE group_agents
                SET display_name = '保留名', display_name_key = '保留名',
                    description = '保留职责', stored_session_id = 'stored-old',
                    last_context_message_seq = 2, enabled = 0,
                    reply_without_mention = 1, model_override = 'model-old',
                    provider_override = 'provider-old',
                    reasoning_effort_override = 'high', fast_mode_override = 1,
                    session_config_json = '{"fast":true}'
                WHERE id = ?""",
                (agent_id,),
            )
            expected_room = dict(
                connection.execute(
                    "SELECT * FROM group_rooms WHERE id = ?", (room_id,)
                ).fetchone()
            )
            expected_agent = dict(
                connection.execute(
                    "SELECT * FROM group_agents WHERE id = ?", (agent_id,)
                ).fetchone()
            )
            second_message, second_run = new_id(), new_id()
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning,
                 tool_state_json, status, error, visible, created_at, updated_at)
                VALUES (?, ?, 'human', 'human', '你', ?, NULL, ?, '第二话题', '',
                        '[]', 'completed', '', 1, 2, 2)""",
                (second_message, room_id, second_message, new_id()),
            )
            connection.execute(
                """INSERT INTO group_agent_runs
                (id, room_id, agent_id, trigger_message_id, response_message_id,
                 root_message_id, depth, reply_mode, status, runtime_session_id,
                 error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, 'mentioned', 'running',
                        'runtime-old', '', 2, 2)""",
                (
                    second_run,
                    room_id,
                    agent_id,
                    second_message,
                    second_message,
                    second_message,
                ),
            )
            connection.execute(
                """INSERT INTO group_interactions
                (id, room_id, agent_id, run_id, kind, payload_json, status,
                 created_at, resolved_at)
                VALUES ('legacy-interaction', ?, ?, ?, 'approval', '{}',
                        'pending', 2, NULL)""",
                (room_id, agent_id, second_run),
            )
            failed_interaction_request = new_id()
            connection.execute(
                """INSERT INTO group_idempotency
                (request_id, operation, request_hash, response_json, created_at)
                VALUES (?, 'interaction.approval.response:legacy-interaction',
                        'legacy-failed-hash', ?, 2)""",
                (
                    failed_interaction_request,
                    GroupStore._canonical_json({
                        "state": "failed",
                        "reason": "legacy failure",
                        "runtimeSessionIds": [],
                        "run": {
                            "id": second_run,
                            "triggerMessageId": second_message,
                        },
                    }),
                ),
            )
            replay_request = new_id()
            old_payload = {
                "roomId": room_id,
                "clientMessageId": first_message["client_message_id"],
                "content": first_message["content"],
                "mentionAgentIds": [],
            }
            old_response = {
                "message": {"id": first_message["id"], "senderKind": "human"},
                "runs": [],
            }
            connection.execute(
                """INSERT INTO group_idempotency
                (request_id, operation, request_hash, response_json, created_at)
                VALUES (?, 'message.create', ?, ?, 1)""",
                (
                    replay_request,
                    hashlib.sha256(
                        GroupStore._canonical_json(old_payload).encode()
                    ).hexdigest(),
                    GroupStore._canonical_json(old_response),
                ),
            )
            connection.execute(
                """INSERT INTO group_events
                (epoch, room_id, event_type, payload_json, created_at)
                VALUES ('11111111-1111-4111-8111-111111111111', ?,
                        'message.upsert', ?, 1)""",
                (room_id, GroupStore._canonical_json(old_response["message"])),
            )
            connection.execute(
                """INSERT INTO group_events
                (epoch, room_id, event_type, payload_json, created_at)
                VALUES ('11111111-1111-4111-8111-111111111111', ?,
                        'run.updated', ?, 2)""",
                (
                    room_id,
                    GroupStore._canonical_json({
                        "id": second_run,
                        "triggerMessageId": second_message,
                    }),
                ),
            )
            connection.execute(
                """INSERT INTO group_events
                (epoch, room_id, event_type, payload_json, created_at)
                VALUES ('11111111-1111-4111-8111-111111111111', ?,
                        'interaction.requested', ?, 2)""",
                (
                    room_id,
                    GroupStore._canonical_json({
                        "id": "legacy-interaction",
                        "runId": second_run,
                        "kind": "approval",
                    }),
                ),
            )
            connection.commit()
            connection.close()

            store = GroupStore(path)
            store.initialize()
            self.assertEqual(store.schema_version(), 12)
            with store.connection() as migrated:
                room = migrated.execute("SELECT * FROM group_rooms").fetchone()
                agent = migrated.execute("SELECT * FROM group_agents").fetchone()
                topics = migrated.execute(
                    "SELECT * FROM group_topics ORDER BY created_at, id"
                ).fetchall()
                states = migrated.execute(
                    """SELECT * FROM group_agent_topic_state
                    WHERE agent_id = ? ORDER BY topic_id""",
                    (agent_id,),
                ).fetchall()
                interaction = migrated.execute(
                    "SELECT * FROM group_interactions WHERE id = 'legacy-interaction'"
                ).fetchone()
                active_run = migrated.execute(
                    "SELECT * FROM group_agent_runs WHERE id = ?", (second_run,)
                ).fetchone()
                failed_interaction_replay = json.loads(
                    migrated.execute(
                        """SELECT response_json FROM group_idempotency
                        WHERE request_id = ?""",
                        (failed_interaction_request,),
                    ).fetchone()[0]
                )
            self.assertEqual(
                dict(room), {
                    **expected_room,
                    "orchestration_mode": "free",
                    "instructions": "",
                }
            )
            self.assertEqual(dict(agent), {**expected_agent, "is_host": 1})
            self.assertEqual(
                (room["name"], room["max_reply_rounds"], room["archived"]),
                ("保留群", 7, 1),
            )
            self.assertEqual(
                (
                    agent["profile"],
                    agent["display_name"],
                    agent["description"],
                    agent["stored_session_id"],
                    agent["last_context_message_seq"],
                    agent["enabled"],
                    agent["reply_without_mention"],
                    agent["model_override"],
                    agent["provider_override"],
                    agent["reasoning_effort_override"],
                    agent["fast_mode_override"],
                    agent["session_config_json"],
                ),
                (
                    "default",
                    "保留名",
                    "保留职责",
                    "stored-old",
                    2,
                    0,
                    1,
                    "model-old",
                    "provider-old",
                    "high",
                    1,
                    '{"fast":true}',
                ),
            )
            self.assertEqual(
                {topic["id"] for topic in topics},
                {first_message["root_message_id"], second_message},
            )
            self.assertEqual(
                {
                    state["topic_id"]: state["last_context_message_seq"]
                    for state in states
                },
                {first_message["root_message_id"]: 1, second_message: 2},
            )
            self.assertEqual(interaction["topic_id"], second_message)
            self.assertEqual(active_run["topic_id"], second_message)
            self.assertEqual(active_run["runtime_session_id"], "runtime-old")
            self.assertNotIn("topicId", failed_interaction_replay["run"])
            replay = store.create_human_message(
                room_id,
                request_id=replay_request,
                client_message_id=first_message["client_message_id"],
                content=first_message["content"],
                mention_agent_ids=[],
            )
            self.assertEqual(
                replay["message"]["topicId"], first_message["root_message_id"]
            )
            historical_events = store.events_after(0, 3)
            self.assertEqual(
                [event["payload"]["topicId"] for event in historical_events],
                [
                    first_message["root_message_id"],
                    second_message,
                    second_message,
                ],
            )

    def test_v3_migration_rolls_back_atomically_on_invalid_topic_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            SETTINGS_TESTS.GroupSettingsContractTests._create_v1_database(path)
            connection = sqlite3.connect(path)
            connection.row_factory = sqlite3.Row
            GroupStore._migrate_v1_to_v2(connection)
            GroupStore._migrate_v2_to_v3(connection)
            connection.execute(
                "UPDATE group_messages SET root_message_id = 'invalid-topic'"
            )
            connection.execute(
                "UPDATE group_agent_runs SET root_message_id = 'invalid-topic'"
            )
            connection.commit()
            connection.close()

            with self.assertRaises(STORE_MODULE.GroupStoreError):
                GroupStore(path).initialize()
            verification = sqlite3.connect(path)
            version = verification.execute(
                "SELECT value FROM group_meta WHERE key = 'schema_version'"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in verification.execute(
                    """SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"""
                )
            }
            verification.close()
            self.assertEqual(version, "3")
            self.assertNotIn("group_topics", tables)
            self.assertNotIn("group_agent_topic_state", tables)

    @staticmethod
    def _downgrade_to_early_v4(connection: sqlite3.Connection) -> None:
        connection.execute(
            """CREATE TABLE group_messages_early_fixture (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
                topic_id TEXT NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
                sender_kind TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                reply_to_message_id TEXT,
                client_message_id TEXT UNIQUE,
                content TEXT NOT NULL DEFAULT '',
                reasoning TEXT NOT NULL DEFAULT '',
                tool_state_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                visible INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )"""
        )
        connection.execute(
            """INSERT INTO group_messages_early_fixture
            SELECT * FROM group_messages ORDER BY seq"""
        )
        connection.execute(
            """CREATE TABLE group_agent_runs_early_fixture (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
                agent_id TEXT NOT NULL,
                trigger_message_id TEXT NOT NULL,
                response_message_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                depth INTEGER NOT NULL,
                reply_mode TEXT NOT NULL DEFAULT 'mentioned',
                status TEXT NOT NULL,
                runtime_session_id TEXT,
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )"""
        )
        connection.execute(
            """INSERT INTO group_agent_runs_early_fixture
            SELECT id, room_id, topic_id, agent_id, trigger_message_id,
                   response_message_id, root_message_id, depth, reply_mode,
                   status, runtime_session_id, error, created_at, updated_at
            FROM group_agent_runs"""
        )
        connection.execute(
            """CREATE TABLE group_interactions_early_fixture (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                topic_id TEXT NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
                agent_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                resolved_at REAL
            )"""
        )
        connection.execute(
            """INSERT INTO group_interactions_early_fixture
            SELECT * FROM group_interactions"""
        )
        connection.execute("DROP TABLE group_interactions")
        connection.execute("DROP TABLE group_agent_runs")
        connection.execute("DROP TABLE group_messages")
        connection.execute(
            "ALTER TABLE group_messages_early_fixture RENAME TO group_messages"
        )
        connection.execute(
            "ALTER TABLE group_agent_runs_early_fixture RENAME TO group_agent_runs"
        )
        connection.execute(
            "ALTER TABLE group_interactions_early_fixture RENAME TO group_interactions"
        )
        connection.execute("DROP INDEX IF EXISTS idx_group_agents_room_host")
        connection.execute("ALTER TABLE group_agents DROP COLUMN is_host")
        connection.execute(
            "UPDATE group_meta SET value = '4' WHERE key = 'schema_version'"
        )

    @staticmethod
    def _repair_snapshot(connection: sqlite3.Connection) -> dict[str, object]:
        ordering = {
            "group_meta": "key",
            "group_rooms": "id",
            "group_topics": "id",
            "group_agents": "id",
            "group_agent_topic_state": "agent_id, topic_id",
            "group_messages": "seq",
            "group_agent_runs": "id",
            "group_interactions": "id",
            "group_events": "cursor",
            "group_idempotency": "request_id",
        }
        return {
            table: [
                tuple(row)
                for row in connection.execute(
                    f"SELECT * FROM {table} ORDER BY {order_by}"
                )
            ]
            for table, order_by in ordering.items()
        }

    @staticmethod
    def _create_legacy_database(
        path: Path, *, version: int, stored_session_id: str | None
    ) -> tuple[str, str, str]:
        if version not in {2, 3}:
            raise ValueError("legacy test version must be 2 or 3")
        SETTINGS_TESTS.GroupSettingsContractTests._create_v1_database(path)
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        GroupStore._migrate_v1_to_v2(connection)
        room_id = connection.execute("SELECT id FROM group_rooms").fetchone()[0]
        agent_id = connection.execute("SELECT id FROM group_agents").fetchone()[0]
        topic_id = connection.execute(
            "SELECT root_message_id FROM group_messages ORDER BY seq LIMIT 1"
        ).fetchone()[0]
        connection.execute(
            """UPDATE group_agents
            SET stored_session_id = ?, last_context_message_seq = 1
            WHERE id = ?""",
            (stored_session_id, agent_id),
        )
        if version == 3:
            GroupStore._migrate_v2_to_v3(connection)
            connection.execute(
                "UPDATE group_agents SET session_config_json = NULL WHERE id = ?",
                (agent_id,),
            )
        connection.commit()
        connection.close()
        return room_id, agent_id, topic_id

    @staticmethod
    def _default_session_configuration() -> dict[str, object]:
        return {
            "model": None,
            "provider": None,
            "reasoning_effort": None,
            "fast": None,
        }

    @staticmethod
    def _claim_legacy_topic_continuation(
        store: GroupStore, room_id: str, agent_id: str, topic_id: str
    ) -> dict[str, object]:
        [run] = store.create_human_message(
            room_id,
            request_id=new_id(),
            client_message_id=new_id(),
            topic_id=topic_id,
            content="继续旧话题",
            mention_agent_ids=[agent_id],
        )["runs"]
        claimed = store.claim_next_runnable_run()
        if claimed is None or claimed["id"] != run["id"]:
            raise AssertionError("legacy continuation was not claimed")
        return claimed

    @staticmethod
    def _assert_legacy_schema_rolled_back(path: Path) -> None:
        connection = sqlite3.connect(path)
        version = connection.execute(
            "SELECT value FROM group_meta WHERE key = 'schema_version'"
        ).fetchone()[0]
        tables = {
            row[0]
            for row in connection.execute(
                """SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"""
            )
        }
        connection.close()
        if version != "3" or "group_topics" in tables:
            raise AssertionError("failed migration was not rolled back")

    def _submit_and_settle(
        self,
        store: GroupStore,
        projection: dict[str, object],
        *,
        runtime: str,
        stored: str,
    ) -> None:
        run = projection["run"]
        agent = projection["agent"]
        store.bind_run_runtime(run["id"], runtime)
        store.commit_prompt_submission(
            run["id"],
            expected_stored_session_id=agent["storedSessionId"],
            stored_session_id=stored,
            runtime_session_id=runtime,
            expected_context_seq=agent["lastContextMessageSeq"],
            through_seq=projection["throughSeq"],
        )
        store.upsert_agent_message(
            run["id"],
            content="完成",
            reasoning="",
            tool_state=[],
            status="completed",
        )
        store.settle_run(
            run["id"],
            runtime_session_id=runtime,
            expected_stored_session_id=stored,
            stored_session_id=stored,
            outcome="completed",
        )


if __name__ == "__main__":
    unittest.main()
