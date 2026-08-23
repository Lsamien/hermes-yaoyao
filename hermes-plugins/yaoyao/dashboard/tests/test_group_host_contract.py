from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import uuid


DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import group_plugin_api  # noqa: E402


PROTOCOL = importlib.import_module(f"{group_plugin_api._LOCAL_PACKAGE}.group_protocol")
STORE_MODULE = importlib.import_module(f"{group_plugin_api._LOCAL_PACKAGE}.group_store")
ORCHESTRATOR = importlib.import_module(
    f"{group_plugin_api._LOCAL_PACKAGE}.group_orchestrator"
)
GroupStore = STORE_MODULE.GroupStore


def new_id() -> str:
    return str(uuid.uuid4())


class GroupHostContractTests(unittest.TestCase):
    def test_protocol_v5_host_fields_are_independent_and_compatible(self) -> None:
        self.assertEqual(PROTOCOL.PROTOCOL_VERSION, 5)
        legacy = PROTOCOL.CreateRoomRequest.model_validate({
            "requestId": new_id(),
            "name": "兼容群",
            "agents": [{"profile": "legacy", "replyWithoutMention": True}],
        })
        self.assertFalse(legacy.agents[0].is_host)
        self.assertTrue(legacy.agents[0].reply_without_mention)
        legacy_command = group_plugin_api._create_room_command(legacy)
        self.assertNotIn("isHost", legacy_command["agents"][0])

        explicit = PROTOCOL.CreateRoomRequest.model_validate({
            "requestId": new_id(),
            "name": "v5 群",
            "agents": [
                {"profile": "host", "isHost": True},
                {"profile": "observer", "replyWithoutMention": True},
            ],
        })
        explicit_command = group_plugin_api._create_room_command(explicit)
        self.assertIs(explicit_command["agents"][0]["isHost"], True)
        self.assertNotIn("isHost", explicit_command["agents"][1])
        update = PROTOCOL.UpdateAgentRequest.model_validate({
            "requestId": new_id(),
            "isHost": True,
        })
        self.assertIs(update.is_host, True)

        with self.assertRaisesRegex(ValueError, "only one host"):
            PROTOCOL.CreateRoomRequest.model_validate({
                "requestId": new_id(),
                "name": "非法群",
                "agents": [
                    {"profile": "one", "isHost": True},
                    {"profile": "two", "isHost": True},
                ],
            })

    def test_human_routing_uses_host_only_when_no_valid_mention(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "路由群",
                "cwd": "",
                "agents": [
                    {
                        "profile": "host",
                        "isHost": True,
                        "replyWithoutMention": True,
                    },
                    {"profile": "automatic", "replyWithoutMention": True},
                    {"profile": "explicit"},
                    {"profile": "disabled", "replyWithoutMention": True},
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            store.update_agent(
                room["id"],
                agents["disabled"]["id"],
                {"requestId": new_id(), "enabled": False},
            )

            no_mention = self._send(store, room["id"], "普通消息", [])
            self.assertEqual(
                self._run_modes(no_mention),
                {
                    agents["host"]["id"]: "automatic",
                    agents["automatic"]["id"]: "automatic",
                },
            )
            with store.connection() as connection:
                flags = {
                    row["agent_id"]: row["required_reply"]
                    for row in connection.execute(
                        """SELECT agent_id, required_reply FROM group_agent_runs
                        WHERE id IN (?, ?)""",
                        tuple(run["id"] for run in no_mention["runs"]),
                    )
                }
                visibility = {
                    row["sender_id"]: row["visible"]
                    for row in connection.execute(
                        """SELECT sender_id, visible FROM group_messages
                        WHERE id IN (?, ?)""",
                        tuple(run["responseMessageId"] for run in no_mention["runs"]),
                    )
                }
            self.assertEqual(
                flags,
                {agents["host"]["id"]: 1, agents["automatic"]["id"]: 0},
            )
            self.assertEqual(
                visibility,
                {agents["host"]["id"]: 1, agents["automatic"]["id"]: 0},
            )

            explicit = self._send(
                store, room["id"], "请处理", [agents["explicit"]["id"]]
            )
            self.assertEqual(
                self._run_modes(explicit),
                {agents["explicit"]["id"]: "mentioned"},
            )
            merged = self._send(
                store,
                room["id"],
                "@automatic 一起处理",
                [agents["explicit"]["id"]],
            )
            self.assertEqual(
                self._run_modes(merged),
                {
                    agents["explicit"]["id"]: "mentioned",
                    agents["automatic"]["id"]: "mentioned",
                },
            )

            for content, ids in (
                ("@不存在 请处理", []),
                ("失效请求目标", [new_id()]),
                ("@disabled 请处理", []),
            ):
                with self.subTest(content=content):
                    fallback = self._send(store, room["id"], content, ids)
                    self.assertEqual(
                        self._run_modes(fallback),
                        {
                            agents["host"]["id"]: "automatic",
                            agents["automatic"]["id"]: "automatic",
                        },
                    )

            everyone = self._send(store, room["id"], "@all 请处理", [])
            self.assertEqual(
                set(self._run_modes(everyone)),
                {
                    agents["host"]["id"],
                    agents["automatic"]["id"],
                    agents["explicit"]["id"],
                },
            )
            self.assertTrue(
                all(mode == "mentioned" for mode in self._run_modes(everyone).values())
            )

    def test_agent_cascade_explicit_mentions_exclude_automatic_members(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "级联群",
                "cwd": "",
                "agents": [
                    {"profile": "source", "isHost": True},
                    {"profile": "automatic", "replyWithoutMention": True},
                    {"profile": "target"},
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            explicit_source = self._insert_completed_source(
                store,
                room["id"],
                agents["source"]["id"],
                content="@target 继续",
            )
            explicit = store.complete_cascade(explicit_source)
            self.assertEqual(
                {store.get_run(run_id)["agentId"] for run_id in explicit["runIds"]},
                {agents["target"]["id"]},
            )

            automatic_source = self._insert_completed_source(
                store,
                room["id"],
                agents["source"]["id"],
                content="没有明确目标",
            )
            automatic = store.complete_cascade(automatic_source)
            self.assertEqual(
                {store.get_run(run_id)["agentId"] for run_id in automatic["runIds"]},
                {agents["automatic"]["id"]},
            )

    def test_eight_member_no_mention_routing_deduplicates_the_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "八成员群",
                "cwd": "",
                "agents": [
                    {
                        "profile": "host",
                        "isHost": True,
                        "replyWithoutMention": True,
                    },
                    *[
                        {
                            "profile": f"automatic-{index}",
                            "replyWithoutMention": True,
                        }
                        for index in range(1, 8)
                    ],
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}

            response = self._send(store, room["id"], "普通消息", [])

            self.assertEqual(len(response["runs"]), 8)
            self.assertEqual(
                {run["agentId"] for run in response["runs"]},
                {agent["id"] for agent in agents.values()},
            )
            with store.connection() as connection:
                flags = connection.execute(
                    """SELECT agent_id, required_reply FROM group_agent_runs
                    WHERE root_message_id = ? ORDER BY agent_id""",
                    (response["message"]["id"],),
                ).fetchall()
            self.assertEqual(sum(row["required_reply"] for row in flags), 1)
            self.assertEqual(
                next(row["agent_id"] for row in flags if row["required_reply"]),
                agents["host"]["id"],
            )

    def test_host_switch_is_atomic_and_idempotent_replay_is_frozen(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "切换群",
                "cwd": "",
                "agents": [
                    {"profile": "one", "isHost": True},
                    {"profile": "two"},
                    {"profile": "three"},
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            with self.assertRaisesRegex(
                STORE_MODULE.GroupConflictError, "cannot be cleared"
            ):
                store.update_agent(
                    room["id"],
                    agents["one"]["id"],
                    {"requestId": new_id(), "isHost": False},
                )

            before = store.latest_cursor()
            switch_request = new_id()
            first = store.update_agent(
                room["id"],
                agents["two"]["id"],
                {"requestId": switch_request, "isHost": True},
            )
            self.assertIs(first["isHost"], True)
            events = store.events_after(before, 10)
            agent_events = [
                event for event in events if event["eventType"] == "agent.updated"
            ]
            self.assertEqual(
                [(event["payload"]["id"], event["payload"]["isHost"]) for event in agent_events],
                [(agents["one"]["id"], False), (agents["two"]["id"], True)],
            )

            store.update_agent(
                room["id"],
                agents["three"]["id"],
                {"requestId": new_id(), "isHost": True},
            )
            replay = store.update_agent(
                room["id"],
                agents["two"]["id"],
                {"requestId": switch_request, "isHost": True},
            )
            self.assertEqual(replay, first)
            self.assertIs(replay["isHost"], True)
            current = store.get_room(room["id"])["agents"]
            self.assertEqual(
                [agent["id"] for agent in current if agent["isHost"]],
                [agents["three"]["id"]],
            )

    def test_host_disable_delete_promotion_and_no_replacement_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "顺延群",
                "cwd": "",
                "agents": [
                    {"profile": "host", "isHost": True},
                    {"profile": "second"},
                    {"profile": "third"},
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            expected_after_disable = min(
                (agents["second"], agents["third"]),
                key=lambda agent: (agent["createdAt"], agent["id"]),
            )
            store.update_agent(
                room["id"],
                agents["host"]["id"],
                {"requestId": new_id(), "enabled": False},
            )
            current = store.get_room(room["id"])["agents"]
            self.assertEqual(
                [agent["id"] for agent in current if agent["isHost"]],
                [expected_after_disable["id"]],
            )

            store.delete_agent(
                room["id"], expected_after_disable["id"], {"requestId": new_id()}
            )
            current = store.get_room(room["id"])["agents"]
            self.assertEqual(sum(agent["isHost"] for agent in current), 1)
            self.assertTrue(next(agent for agent in current if agent["isHost"])["enabled"])

            sole = store.create_room({
                "requestId": new_id(),
                "name": "无替代群",
                "cwd": "",
                "agents": [
                    {"profile": "host", "isHost": True},
                    {"profile": "disabled"},
                ],
            })
            sole_agents = {agent["profile"]: agent for agent in sole["agents"]}
            store.update_agent(
                sole["id"],
                sole_agents["disabled"]["id"],
                {"requestId": new_id(), "enabled": False},
            )
            with self.assertRaisesRegex(
                STORE_MODULE.GroupConflictError, "enabled replacement"
            ):
                store.update_agent(
                    sole["id"],
                    sole_agents["host"]["id"],
                    {"requestId": new_id(), "enabled": False},
                )
            with self.assertRaisesRegex(
                STORE_MODULE.GroupConflictError, "enabled replacement"
            ):
                store.delete_agent(
                    sole["id"],
                    sole_agents["host"]["id"],
                    {"requestId": new_id()},
                )

    def test_enabling_agent_promotes_it_when_migrated_host_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "恢复群",
                "cwd": "",
                "agents": [{"profile": "old"}, {"profile": "new"}],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            with store.connection() as connection:
                connection.execute(
                    "UPDATE group_agents SET enabled = 0 WHERE room_id = ?",
                    (room["id"],),
                )
            promoted = store.update_agent(
                room["id"],
                agents["new"]["id"],
                {"requestId": new_id(), "enabled": True},
            )
            self.assertIs(promoted["isHost"], True)
            current = store.get_room(room["id"])["agents"]
            self.assertEqual(
                [agent["id"] for agent in current if agent["isHost"]],
                [agents["new"]["id"]],
            )

    def test_v4_migration_selects_host_and_preserves_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            store = GroupStore(path)
            store.initialize()
            preferred_room = store.create_room({
                "requestId": new_id(),
                "name": "优先级群",
                "cwd": "",
                "agents": [
                    {"profile": "plain"},
                    {"profile": "auto-one", "replyWithoutMention": True},
                    {"profile": "auto-two", "replyWithoutMention": True},
                ],
            })
            disabled_room = store.create_room({
                "requestId": new_id(),
                "name": "全禁用群",
                "cwd": "",
                "agents": [{"profile": "old-one"}, {"profile": "old-two"}],
            })
            preferred_agents = {
                agent["profile"]: agent for agent in preferred_room["agents"]
            }
            expected_preferred = min(
                (preferred_agents["auto-one"], preferred_agents["auto-two"]),
                key=lambda agent: (agent["createdAt"], agent["id"]),
            )
            expected_disabled = min(
                disabled_room["agents"],
                key=lambda agent: (agent["createdAt"], agent["id"]),
            )
            with store.connection() as connection:
                connection.execute(
                    "UPDATE group_agents SET enabled = 0 WHERE room_id = ?",
                    (disabled_room["id"],),
                )
                before_counts = {
                    table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for table in (
                        "group_rooms",
                        "group_agents",
                        "group_messages",
                        "group_agent_runs",
                        "group_topics",
                    )
                }
                connection.execute("DROP INDEX idx_group_agents_room_host")
                connection.execute("ALTER TABLE group_agents DROP COLUMN is_host")
                connection.execute(
                    "ALTER TABLE group_agent_runs DROP COLUMN required_reply"
                )
                connection.execute(
                    "UPDATE group_meta SET value = '4' WHERE key = 'schema_version'"
                )

            migrated = GroupStore(path)
            migrated.initialize()
            self.assertEqual(migrated.schema_version(), 5)
            with migrated.connection() as connection:
                after_counts = {
                    table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for table in before_counts
                }
                preferred_host = connection.execute(
                    "SELECT * FROM group_agents WHERE room_id = ? AND is_host = 1",
                    (preferred_room["id"],),
                ).fetchone()
                disabled_host = connection.execute(
                    "SELECT * FROM group_agents WHERE room_id = ? AND is_host = 1",
                    (disabled_room["id"],),
                ).fetchone()
                replay = json.loads(
                    connection.execute(
                        """SELECT response_json FROM group_idempotency
                        WHERE operation = 'room.created' AND response_json LIKE ?""",
                        (f'%{preferred_room["id"]}%',),
                    ).fetchone()[0]
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "UPDATE group_agents SET is_host = 1 WHERE id != ? AND room_id = ?",
                        (preferred_host["id"], preferred_room["id"]),
                    )
            self.assertEqual(after_counts, before_counts)
            self.assertEqual(preferred_host["id"], expected_preferred["id"])
            self.assertEqual(disabled_host["id"], expected_disabled["id"])
            self.assertEqual(disabled_host["enabled"], 0)
            self.assertEqual(sum(agent["isHost"] for agent in replay["agents"]), 1)
            self.assertEqual(
                next(agent["id"] for agent in replay["agents"] if agent["isHost"]),
                expected_preferred["id"],
            )

    def test_concurrent_host_switches_preserve_unique_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "并发群",
                "cwd": "",
                "agents": [
                    {"profile": "host", "isHost": True},
                    {"profile": "left"},
                    {"profile": "right"},
                ],
            })
            agents = {agent["profile"]: agent for agent in room["agents"]}
            barrier = threading.Barrier(2)

            def switch(profile: str) -> dict[str, object]:
                barrier.wait()
                return store.update_agent(
                    room["id"],
                    agents[profile]["id"],
                    {"requestId": new_id(), "isHost": True},
                )

            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(switch, ("left", "right")))
            self.assertTrue(all(result["isHost"] for result in results))
            current = store.get_room(room["id"])["agents"]
            self.assertEqual(sum(agent["isHost"] for agent in current), 1)

    def test_required_host_prompt_fallback_and_failure_are_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": new_id(),
                "name": "必答群",
                "cwd": "",
                "agents": [{"profile": "host", "isHost": True}],
            })
            created = self._send(store, room["id"], "请主持", [])
            [run] = created["runs"]
            claimed = store.claim_next_runnable_run()
            projection = store.read_run_projection(claimed["id"])
            self.assertIs(projection["run"]["requiredReply"], True)
            prompt = ORCHESTRATOR.build_run_prompt(
                projection, store.get_room(room["id"])["agents"]
            )
            envelope = json.loads(prompt.rsplit("GROUP_CONTEXT_JSON=", 1)[1])
            self.assertIs(envelope["run"]["requiredReply"], True)
            self.assertIn("唯一主持人", prompt)
            self.assertNotIn("[[YAOYAO_NO_REPLY_V1]]", prompt)

            before = store.latest_cursor()
            store.transition_run(run["id"], "failed", error="配置失败")
            events = store.events_after(before, 10)
            self.assertTrue(
                any(event["eventType"] == "message.upsert" for event in events)
            )
            response = store.get_message(run["responseMessageId"])
            self.assertEqual(response["status"], "failed")
            self.assertEqual(response["error"], "配置失败")

        fallback, clarification = asyncio.run(self._exercise_required_reply_runtime())
        self.assertEqual(fallback[-1]["content"], ORCHESTRATOR._HOST_FALLBACK_REPLY)
        self.assertTrue(fallback[-1]["publish"])
        self.assertEqual(clarification[-1]["content"], "")

    @staticmethod
    async def _exercise_required_reply_runtime() -> tuple[
        list[dict[str, object]], list[dict[str, object]]
    ]:
        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(
                self, _run_id: str, **kwargs: object
            ) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

            def create_gateway_interaction(
                self, _run_id: str, **_kwargs: object
            ) -> dict[str, object]:
                return {"id": new_id()}

            def expire_interaction(self, interaction_id: str) -> dict[str, object]:
                return {"id": interaction_id}

        async def complete(*, clarify: bool) -> list[dict[str, object]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            state = ORCHESTRATOR._RuntimeState(
                run_id=new_id(),
                room_id=new_id(),
                agent_id=new_id(),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
                required_reply=True,
                automatic_published=True,
            )
            if clarify:
                await orchestrator._apply_runtime_event(
                    state,
                    ORCHESTRATOR._GatewayEvent(
                        runtime_id="runtime",
                        generation=1,
                        event_type="clarify.request",
                        payload={"request_id": "clarify-1", "question": "请补充"},
                    ),
                )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={
                        "status": "complete",
                        "text": "[[YAOYAO_NO_REPLY_V1]]",
                    },
                ),
            )
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return store.upserts

        return await complete(clarify=False), await complete(clarify=True)

    @staticmethod
    def _send(
        store: GroupStore, room_id: str, content: str, mention_ids: list[str]
    ) -> dict[str, object]:
        return store.create_human_message(
            room_id,
            request_id=new_id(),
            client_message_id=new_id(),
            content=content,
            mention_agent_ids=mention_ids,
        )

    @staticmethod
    def _run_modes(result: dict[str, object]) -> dict[str, str]:
        return {run["agentId"]: run["replyMode"] for run in result["runs"]}

    @staticmethod
    def _insert_completed_source(
        store: GroupStore, room_id: str, agent_id: str, *, content: str
    ) -> str:
        message_id, run_id = new_id(), new_id()
        with store.write_transaction() as connection:
            now = store._now()
            store._ensure_topic(connection, room_id, message_id, content, now)
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, topic_id, sender_kind, sender_id, sender_name,
                 root_message_id, reply_to_message_id, client_message_id,
                 content, reasoning, tool_state_json, status, error, visible,
                 created_at, updated_at)
                VALUES (?, ?, ?, 'agent', ?, 'source', ?, NULL, NULL, ?, '', '[]',
                        'completed', '', 1, ?, ?)""",
                (
                    message_id,
                    room_id,
                    message_id,
                    agent_id,
                    message_id,
                    content,
                    now,
                    now,
                ),
            )
            connection.execute(
                """INSERT INTO group_agent_runs
                (id, room_id, topic_id, agent_id, trigger_message_id,
                 response_message_id, root_message_id, depth, reply_mode,
                 required_reply, status, runtime_session_id, error, created_at,
                 updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'mentioned', 0, 'completed',
                        NULL, '', ?, ?)""",
                (
                    run_id,
                    room_id,
                    message_id,
                    agent_id,
                    message_id,
                    message_id,
                    message_id,
                    now,
                    now,
                ),
            )
            store._record_cascade_plan(
                connection,
                source=store._run_row(connection, run_id),
                source_message=store._message_row(connection, message_id),
                created_at=now,
            )
        return run_id


if __name__ == "__main__":
    unittest.main()
