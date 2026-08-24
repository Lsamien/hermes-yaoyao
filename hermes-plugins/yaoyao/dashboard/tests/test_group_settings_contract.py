from __future__ import annotations

import importlib
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import subprocess
import tempfile
import textwrap
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
GATEWAY = importlib.import_module(f"{group_plugin_api._LOCAL_PACKAGE}.group_gateway")
GroupStore = STORE_MODULE.GroupStore


def request_id() -> str:
    return str(uuid.uuid4())


class GroupSettingsContractTests(unittest.TestCase):
    def test_room_instructions_round_trip_into_agent_prompt(self) -> None:
        create = PROTOCOL.CreateRoomRequest.model_validate({
            "requestId": request_id(),
            "name": "规则群",
            "instructions": "  先核对事实。\r\n结论使用中文。  ",
            "agents": [{"profile": "default"}],
        })
        self.assertEqual(create.instructions, "先核对事实。\n结论使用中文。")
        self.assertEqual(
            PROTOCOL.limits_payload()["maxRoomInstructionsLength"], 4_000
        )
        with self.assertRaises(ValueError):
            PROTOCOL.UpdateRoomRequest.model_validate({
                "requestId": request_id(),
                "instructions": "x" * 4_001,
            })

        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room({
                "requestId": request_id(),
                "name": "规则群",
                "cwd": "",
                "instructions": create.instructions,
                "agents": [{"profile": "default"}],
            })
            self.assertEqual(room["instructions"], create.instructions)
            [agent] = room["agents"]
            created = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="请执行",
                mention_agent_ids=[agent["id"]],
            )
            claimed = store.claim_next_runnable_run()
            self.assertEqual(claimed["id"], created["runs"][0]["id"])
            projection = store.read_run_projection(claimed["id"])
            self.assertEqual(
                projection["room"]["instructions"], create.instructions
            )
            prompt = ORCHESTRATOR.build_run_prompt(projection, room["agents"])
            self.assertIn("长期说明、协作规则和形式准则", prompt)
            self.assertIn("先核对事实", prompt)

            updated = store.update_room(
                room["id"],
                {"requestId": request_id(), "instructions": ""},
            )
            self.assertEqual(updated["instructions"], "")

    def test_v11_database_migrates_empty_room_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            store = GroupStore(path)
            store.initialize()
            room = store.create_room({
                "requestId": request_id(),
                "name": "旧房间",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            with store.connection() as connection:
                connection.execute("ALTER TABLE group_rooms DROP COLUMN instructions")
                connection.execute(
                    "UPDATE group_meta SET value = '11' WHERE key = 'schema_version'"
                )

            migrated = GroupStore(path)
            migrated.initialize()
            self.assertEqual(migrated.schema_version(), 12)
            self.assertEqual(migrated.get_room(room["id"])["instructions"], "")

    def test_terminal_session_info_captures_effective_model_for_settlement(self) -> None:
        async def exercise() -> tuple[object, dict[str, object]]:
            orchestrator = ORCHESTRATOR.GroupOrchestrator(object())
            state = ORCHESTRATOR._RuntimeState(
                run_id=request_id(),
                room_id=request_id(),
                topic_id=request_id(),
                agent_id=request_id(),
                runtime_id="runtime-effective-model",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored-before",
                expected_context_seq=0,
                through_seq=0,
                profile="default",
                complete_seen=True,
                complete_index=1,
                event_index=2,
                terminal_status="completed",
            )
            captured: dict[str, object] = {}

            async def capture(_state: object, **kwargs: object) -> None:
                captured.update(kwargs)

            orchestrator._finalize_state_locked = capture  # type: ignore[method-assign]
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id=state.runtime_id,
                    generation=state.generation,
                    event_type="session.info",
                    payload={
                        "running": False,
                        "stored_session_id": "stored-after",
                        "profile_name": "default",
                        "model": "claude-sonnet-4-6",
                        "provider": "anthropic",
                        "reasoning_effort": "xhigh",
                        "fast": True,
                    },
                ),
            )
            return state, captured

        state, captured = asyncio.run(exercise())
        self.assertEqual(state.actual_model, "claude-sonnet-4-6")
        self.assertEqual(state.actual_provider, "anthropic")
        self.assertEqual(state.actual_reasoning_effort, "xhigh")
        self.assertTrue(state.actual_fast_mode)
        self.assertEqual(captured["outcome"], "completed")
        self.assertEqual(captured["stored_session_id"], "stored-after")

    def test_run_records_configured_and_effective_model_on_topic_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "模型记录群",
                    "cwd": "",
                    "agents": [
                        {
                            "profile": "default",
                            "model": "gpt-5.6",
                            "provider": "openai-codex",
                            "reasoningEffort": "high",
                            "fastMode": False,
                        }
                    ],
                }
            )
            created = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="请回答",
                mention_agent_ids=[room["agents"][0]["id"]],
            )
            run = created["runs"][0]
            self.assertEqual(run["requestedModel"], "gpt-5.6")
            self.assertEqual(run["requestedProvider"], "openai-codex")
            self.assertEqual(run["requestedReasoningEffort"], "high")
            self.assertFalse(run["requestedFastMode"])
            self.assertIsNone(run["actualModel"])

            claimed = store.claim_next_runnable_run()
            self.assertEqual(claimed["id"], run["id"])
            store.bind_run_runtime(run["id"], "runtime-model-attribution")
            store.upsert_agent_message(
                run["id"],
                content="已使用备用模型完成",
                reasoning="",
                tool_state=[],
                status="completed",
            )
            settled = store.settle_run(
                run["id"],
                runtime_session_id="runtime-model-attribution",
                expected_stored_session_id=None,
                stored_session_id="stored-model-attribution",
                outcome="completed",
                actual_model="claude-sonnet-4-6",
                actual_provider="anthropic",
                actual_reasoning_effort="xhigh",
                actual_fast_mode=True,
            )
            self.assertEqual(
                settled["run"]["actualModel"], "claude-sonnet-4-6"
            )
            self.assertEqual(settled["run"]["actualProvider"], "anthropic")
            self.assertEqual(settled["run"]["actualReasoningEffort"], "xhigh")
            self.assertTrue(settled["run"]["actualFastMode"])

            messages = store.list_messages(
                room["id"], topic_id=created["message"]["topicId"], limit=100
            )
            response = next(item for item in messages if item["senderKind"] == "agent")
            self.assertEqual(
                response["execution"],
                {
                    "requestedModel": "gpt-5.6",
                    "requestedProvider": "openai-codex",
                    "requestedReasoningEffort": "high",
                    "requestedFastMode": False,
                    "actualModel": "claude-sonnet-4-6",
                    "actualProvider": "anthropic",
                    "actualReasoningEffort": "xhigh",
                    "actualFastMode": True,
                },
            )

    def test_gateway_session_create_receives_agent_configuration(self) -> None:
        captured: dict[str, object] = {}
        adapter = GATEWAY.GroupGatewayAdapter(dispatcher=lambda *_: None)

        def request(method: str, params: dict[str, object]) -> dict[str, object]:
            captured["method"] = method
            captured["params"] = params
            return {
                "session_id": "runtime-1",
                "stored_session_id": "stored-1",
                "running": False,
                "info": {"profile_name": "yaoyao"},
            }

        adapter.request = request
        try:
            adapter.create_session(
                "yaoyao",
                "群聊",
                "",
                [],
                {
                    "model": "gpt-5.6-sol",
                    "provider": "openai-codex",
                    "reasoning_effort": "high",
                    "fast": True,
                },
            )
        finally:
            adapter.shutdown()

        self.assertEqual(captured["method"], "session.create")
        params = captured["params"]
        self.assertEqual(params["model"], "gpt-5.6-sol")
        self.assertEqual(params["provider"], "openai-codex")
        self.assertEqual(params["reasoning_effort"], "high")
        self.assertIs(params["fast"], True)

    def test_agent_configuration_round_trips_and_rotates_on_next_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "配置群",
                    "cwd": "",
                    "agents": [{
                        "profile": "yaoyao",
                        "model": "gpt-5.6-sol",
                        "provider": "openai-codex",
                        "reasoningEffort": "high",
                        "fastMode": True,
                    }],
                }
            )
            [agent] = room["agents"]
            self.assertEqual(agent["model"], "gpt-5.6-sol")
            self.assertEqual(agent["provider"], "openai-codex")
            self.assertEqual(agent["reasoningEffort"], "high")
            self.assertIs(agent["fastMode"], True)

            with store.connection() as connection:
                connection.execute(
                    """UPDATE group_agents
                    SET stored_session_id = 'stored-old',
                        last_context_message_seq = 9,
                        session_config_json = '{}'
                    WHERE id = ?""",
                    (agent["id"],),
                )
            store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="开始",
                mention_agent_ids=[agent["id"]],
            )
            claimed = store.claim_next_runnable_run()
            configuration = {
                "model": "gpt-5.6-sol",
                "provider": "openai-codex",
                "reasoning_effort": "high",
                "fast": True,
            }
            self.assertTrue(
                store.prepare_run_session_configuration(claimed["id"], configuration)
            )
            refreshed = store.get_room(room["id"])["agents"][0]
            self.assertIsNone(refreshed["storedSessionId"])
            self.assertEqual(refreshed["lastContextMessageSeq"], 0)
            self.assertFalse(
                store.prepare_run_session_configuration(claimed["id"], configuration)
            )

            cleared = store.update_agent(
                room["id"],
                agent["id"],
                {
                    "requestId": request_id(),
                    "model": None,
                    "provider": None,
                    "reasoningEffort": None,
                    "fastMode": None,
                },
            )
            self.assertIsNone(cleared["model"])
            self.assertIsNone(cleared["provider"])
            self.assertIsNone(cleared["reasoningEffort"])
            self.assertIsNone(cleared["fastMode"])

        with self.assertRaisesRegex(ValueError, "model and provider"):
            PROTOCOL.AddAgentRequest.model_validate({
                "requestId": request_id(),
                "profile": "broken",
                "model": "gpt-5.6-sol",
            })
        with self.assertRaisesRegex(ValueError, "model and provider"):
            PROTOCOL.UpdateAgentRequest.model_validate({
                "requestId": request_id(),
                "model": None,
            })

    def test_run_prompt_accepts_empty_agent_description(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "无职责描述群",
                    "cwd": "",
                    "agents": [{"profile": "default"}],
                }
            )
            [agent] = room["agents"]
            store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="请回复",
                mention_agent_ids=[agent["id"]],
            )
            claimed = store.claim_next_runnable_run()
            self.assertIsNotNone(claimed)
            projection = store.read_run_projection(claimed["id"])

            prompt = ORCHESTRATOR.build_run_prompt(
                projection,
                store.get_room(room["id"])["agents"],
            )

            envelope = json.loads(prompt.rsplit("GROUP_CONTEXT_JSON=", 1)[1])
            self.assertEqual(envelope["agent"]["description"], "")

            invalid_projection = dict(projection)
            invalid_agent = dict(projection["agent"])
            invalid_agent["description"] = 1
            invalid_projection["agent"] = invalid_agent
            with self.assertRaisesRegex(
                ORCHESTRATOR.GroupOrchestratorError,
                "projection.agent.description must be a string",
            ):
                ORCHESTRATOR.build_run_prompt(
                    invalid_projection,
                    store.get_room(room["id"])["agents"],
                )

    def test_protocol_v5_advertises_reply_round_contract(self) -> None:
        self.assertEqual(PROTOCOL.PROTOCOL_VERSION, 10)
        self.assertEqual(
            PROTOCOL.limits_payload()["defaultMaxReplyRounds"], 3
        )
        self.assertEqual(
            PROTOCOL.limits_payload()["unlimitedReplyRoundsValue"], -1
        )
        self.assertEqual(
            PROTOCOL.limits_payload()["maxAgentDisplayNameLength"], 100
        )

        create = PROTOCOL.CreateRoomRequest.model_validate(
            {
                "requestId": request_id(),
                "name": "研发群",
                "agents": [{"profile": "planner"}],
            }
        )
        self.assertEqual(create.max_reply_rounds, 3)
        self.assertIsNone(create.agents[0].display_name)
        self.assertFalse(create.agents[0].reply_without_mention)
        self.assertFalse(create.agents[0].is_host)
        for invalid in (0, -2, 101, True, "3"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                PROTOCOL.CreateRoomRequest.model_validate(
                    {
                        "requestId": request_id(),
                        "name": "研发群",
                        "maxReplyRounds": invalid,
                        "agents": [{"profile": "planner"}],
                    }
                )

    def test_reserved_all_aliases_cannot_be_agent_display_names(self) -> None:
        model_payloads = (
            (
                PROTOCOL.CreateRoomRequest,
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "agents": [{"profile": "planner", "displayName": "所有人"}],
                },
            ),
            (
                PROTOCOL.AddAgentRequest,
                {
                    "requestId": request_id(),
                    "profile": "planner",
                    "displayName": " all ",
                },
            ),
            (
                PROTOCOL.UpdateAgentRequest,
                {"requestId": request_id(), "displayName": "所有人"},
            ),
        )
        for model, payload in model_payloads:
            with self.subTest(model=model.__name__), self.assertRaisesRegex(
                ValueError, "reserved"
            ):
                model.model_validate(payload)

        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(
                Path(directory) / "group.db",
                agent_name_resolver=lambda _profile: "所有人",
            )
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "agents": [{"profile": "planner"}],
                }
            )
            [planner] = room["agents"]
            self.assertEqual(planner["displayName"], "planner")

            with self.assertRaisesRegex(ValueError, "reserved"):
                store.add_agent(
                    room["id"],
                    {
                        "requestId": request_id(),
                        "profile": "coder",
                        "displayName": "所有人",
                    },
                )
            with self.assertRaisesRegex(ValueError, "reserved"):
                store.update_agent(
                    room["id"],
                    planner["id"],
                    {"requestId": request_id(), "displayName": "所有人"},
                )

    def test_agent_name_api_rejects_and_filters_reserved_all_aliases(self) -> None:
        probe = textwrap.dedent(
            """
            import json
            from pathlib import Path
            import sys
            import types

            from fastapi import FastAPI
            from fastapi.testclient import TestClient

            dashboard = Path(sys.argv[1])
            settings_path = Path(sys.argv[2]) / "agent_settings.json"
            sys.path.insert(0, str(dashboard))
            poller = types.ModuleType("poller")
            poller.start = lambda: None
            sys.modules["poller"] = poller

            import plugin_api
            plugin_api._store_for = lambda _profile: object()
            plugin_api.store._agent_settings_path = lambda _profile: settings_path

            app = FastAPI()
            app.include_router(plugin_api.router)
            with TestClient(app) as client:
                rejected = client.put(
                    "/agent/settings",
                    json={"agentName": "所有人"},
                )
                accepted = client.put(
                    "/agent/settings",
                    json={"agentName": "策划"},
                )
                settings_path.write_text(
                    json.dumps(
                        {"profile": "default", "agentName": "all", "updatedAt": 1}
                    ),
                    encoding="utf-8",
                )
                loaded = client.get("/agent/settings")
            print(json.dumps({
                "rejectedStatus": rejected.status_code,
                "acceptedStatus": accepted.status_code,
                "loadedStatus": loaded.status_code,
                "loaded": loaded.json(),
            }, ensure_ascii=False))
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-c", probe, str(DASHBOARD_DIR), directory],
                check=True,
                capture_output=True,
                text=True,
            )
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["rejectedStatus"], 400)
        self.assertEqual(payload["acceptedStatus"], 200)
        self.assertEqual(payload["loadedStatus"], 200)
        self.assertEqual(payload["loaded"]["agentName"], "")

    def test_configured_name_then_profile_fallback_and_all_mention_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(
                Path(directory) / "group.db",
                agent_name_resolver=lambda profile: "策划" if profile == "planner" else "",
            )
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "agents": [
                        {"profile": "planner", "description": "规划"},
                        {"profile": "coder", "description": "开发"},
                        {"profile": "other", "displayName": "planner"},
                    ],
                }
            )
            by_profile = {agent["profile"]: agent for agent in room["agents"]}
            planner, coder = by_profile["planner"], by_profile["coder"]
            self.assertEqual(planner["displayName"], "策划")
            self.assertEqual(coder["displayName"], "coder")

            with store.connection() as connection:
                rows = connection.execute(
                    "SELECT * FROM group_agents WHERE room_id = ? ORDER BY created_at, id",
                    (room["id"],),
                ).fetchall()
            for token, expected in (
                ("@策划", planner["id"]),
                ("@planner", planner["id"]),
                (f"@{planner['id']}", planner["id"]),
                ("@coder", coder["id"]),
            ):
                targets, warnings = store._plan_cascade_mentions(
                    token, rows, source_agent_id=str(uuid.uuid4())
                )
                self.assertEqual(targets, [expected])
                self.assertEqual(warnings, [])

    def test_initialize_syncs_only_legacy_fallback_names_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            legacy = GroupStore(path)
            legacy.initialize()
            room = legacy.create_room(
                {
                    "requestId": request_id(),
                    "name": "旧群",
                    "cwd": "",
                    "agents": [
                        {"profile": "planner"},
                        {"profile": "coder", "displayName": "代码员"},
                        {"profile": "reviewer"},
                    ],
                }
            )
            before = legacy.latest_cursor()

            configured_names = {
                "planner": "策划",
                "coder": "后端",
                "reviewer": "代码员",
            }
            current = GroupStore(
                path,
                agent_name_resolver=lambda profile: configured_names.get(profile, ""),
            )
            current.initialize()

            refreshed = current.get_room(room["id"])
            names = {
                agent["profile"]: agent["displayName"]
                for agent in refreshed["agents"]
            }
            self.assertEqual(
                names,
                {
                    "planner": "策划",
                    "coder": "代码员",
                    "reviewer": "reviewer",
                },
            )
            events = current.events_after(before, 20)
            self.assertEqual(
                [event["eventType"] for event in events],
                ["agent.updated", "room.updated"],
            )
            planner = next(
                agent for agent in refreshed["agents"] if agent["profile"] == "planner"
            )
            self.assertEqual(events[0]["payload"], planner)
            summary = current.list_rooms(limit=100, cursor=None).items[0]
            for key in ("activeRunCount", "unreadCount", "lastMessage"):
                summary.pop(key)
            self.assertEqual(events[1]["payload"], summary)

            after_first_initialize = current.latest_cursor()
            current.initialize()
            self.assertEqual(current.latest_cursor(), after_first_initialize)
            self.assertEqual(current.get_room(room["id"]), refreshed)

    def test_reserved_all_mention_precedes_profile_alias_for_human_and_cascade(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "全员群",
                    "cwd": "",
                    "agents": [
                        {"profile": "all", "displayName": "全能"},
                        {"profile": "所有人", "displayName": "中文全能"},
                        {"profile": "planner"},
                        {"profile": "coder"},
                    ],
                }
            )
            agents = {agent["profile"]: agent for agent in room["agents"]}
            all_ids = {agent["id"] for agent in room["agents"]}

            for token in ("@all 请处理", "@所有人 请处理"):
                with self.subTest(token=token):
                    human_all = store.create_human_message(
                        room["id"],
                        request_id=request_id(),
                        client_message_id=request_id(),
                        content=token,
                        mention_agent_ids=[],
                    )
                    self.assertEqual(
                        {run["agentId"] for run in human_all["runs"]}, all_ids
                    )
                    self.assertTrue(
                        all(
                            run["replyMode"] == "mentioned"
                            for run in human_all["runs"]
                        )
                    )

            for token, expected in (
                ("@planner", agents["planner"]["id"]),
                (f"@{agents['all']['id']}", agents["all"]["id"]),
            ):
                with self.subTest(token=token):
                    created = store.create_human_message(
                        room["id"],
                        request_id=request_id(),
                        client_message_id=request_id(),
                        content=token,
                        mention_agent_ids=[],
                    )
                    self.assertEqual(
                        [run["agentId"] for run in created["runs"]], [expected]
                    )

            for token in ("@all 继续", "@所有人 继续"):
                with self.subTest(cascade=token):
                    source_run_id = self._insert_completed_source(
                        store,
                        room["id"],
                        agents["planner"]["id"],
                        content=token,
                        depth=0,
                    )
                    cascade = store.complete_cascade(source_run_id)
                    self.assertEqual(
                        {
                            store.get_run(run_id)["agentId"]
                            for run_id in cascade["runIds"]
                        },
                        all_ids - {agents["planner"]["id"]},
                    )

    def test_implicit_agent_run_is_hidden_and_explicit_wins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "maxReplyRounds": 3,
                    "agents": [
                        {
                            "profile": "planner",
                            "replyWithoutMention": True,
                        },
                        {
                            "profile": "coder",
                            "replyWithoutMention": True,
                        },
                    ],
                }
            )
            by_profile = {agent["profile"]: agent for agent in room["agents"]}
            planner = by_profile["planner"]
            created = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="请看一下",
                mention_agent_ids=[planner["id"]],
            )
            modes = {run["agentId"]: run["replyMode"] for run in created["runs"]}
            self.assertEqual(modes, {planner["id"]: "mentioned"})
            listed = store.list_messages(room["id"])
            self.assertEqual([message["senderId"] for message in listed], ["human", planner["id"]])

    def test_v1_database_migrates_atomically_and_preserves_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            self._create_v1_database(path)
            store = GroupStore(path)
            store.initialize()
            self.assertEqual(store.schema_version(), 12)
            self.assertEqual(store.journal_epoch(), "11111111-1111-4111-8111-111111111111")
            with store.connection() as connection:
                room = connection.execute("SELECT * FROM group_rooms").fetchone()
                agent = connection.execute("SELECT * FROM group_agents").fetchone()
                run = connection.execute("SELECT * FROM group_agent_runs").fetchone()
                message = connection.execute("SELECT * FROM group_messages").fetchone()
                ledger = connection.execute("SELECT * FROM group_idempotency").fetchone()
            self.assertEqual(room["max_reply_rounds"], 3)
            self.assertEqual(agent["reply_without_mention"], 0)
            self.assertEqual(agent["is_host"], 1)
            self.assertEqual(run["reply_mode"], "mentioned")
            self.assertEqual(run["required_reply"], 0)
            self.assertEqual(message["visible"], 1)
            self.assertEqual(ledger["response_json"], "{}")

    def test_automatic_no_reply_token_is_internal(self) -> None:
        self.assertTrue(ORCHESTRATOR._is_no_reply_content("  [[YAOYAO_NO_REPLY_V1]]\n"))
        self.assertFalse(ORCHESTRATOR._is_no_reply_content("正常回复"))

    def test_v2_schema_with_wrong_defaults_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            self._create_v1_database(path)
            connection = sqlite3.connect(path)
            connection.execute(
                "ALTER TABLE group_rooms ADD COLUMN max_reply_rounds INTEGER NOT NULL DEFAULT 4"
            )
            connection.execute(
                "ALTER TABLE group_agents ADD COLUMN reply_without_mention INTEGER NOT NULL DEFAULT 0"
            )
            connection.execute(
                "ALTER TABLE group_messages ADD COLUMN visible INTEGER NOT NULL DEFAULT 1"
            )
            connection.execute(
                "ALTER TABLE group_agent_runs ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'mentioned'"
            )
            connection.execute(
                "UPDATE group_meta SET value='2' WHERE key='schema_version'"
            )
            connection.commit()
            connection.close()
            with self.assertRaises(STORE_MODULE.GroupStoreError):
                GroupStore(path).initialize()

    def test_v2_room_round_value_corruption_fails_closed(self) -> None:
        self._assert_v2_value_corruption_fails_closed(
            "UPDATE group_rooms SET max_reply_rounds = 0"
        )

    def test_v2_agent_reply_flag_corruption_fails_closed(self) -> None:
        self._assert_v2_value_corruption_fails_closed(
            "UPDATE group_agents SET reply_without_mention = 2"
        )

    def test_v2_message_visibility_corruption_fails_closed(self) -> None:
        self._assert_v2_value_corruption_fails_closed(
            "UPDATE group_messages SET visible = 2"
        )

    def test_v2_run_reply_mode_corruption_fails_closed(self) -> None:
        self._assert_v2_value_corruption_fails_closed(
            "UPDATE group_agent_runs SET reply_mode = 'invalid'"
        )

    def test_v1_create_and_add_ledgers_replay_after_v2_route_dump(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            self._create_v1_database(path)
            create_id, add_id = request_id(), request_id()
            legacy_create = {
                "requestId": create_id,
                "name": "旧客户端群",
                "cwd": "",
                "agents": [
                    {"profile": "legacy", "displayName": None, "description": ""}
                ],
            }
            connection = sqlite3.connect(path)
            room_id = connection.execute("SELECT id FROM group_rooms").fetchone()[0]
            legacy_add = {
                "requestId": add_id,
                "profile": "legacy-added",
                "displayName": None,
                "description": "",
            }
            create_response = {"replayed": "create-v1"}
            add_response = {"replayed": "add-v1"}
            ledgers = (
                (create_id, "room.created", legacy_create, create_response),
                (
                    add_id,
                    "agent.created",
                    {"body": legacy_add, "roomId": room_id},
                    add_response,
                ),
            )
            for ledger_id, operation, payload, response in ledgers:
                canonical_payload = GroupStore._canonical_json(payload)
                connection.execute(
                    """INSERT INTO group_idempotency
                    (request_id, operation, request_hash, response_json, created_at)
                    VALUES (?, ?, ?, ?, 1)""",
                    (
                        ledger_id,
                        operation,
                        hashlib.sha256(canonical_payload.encode()).hexdigest(),
                        GroupStore._canonical_json(response),
                    ),
                )
            connection.commit()
            connection.close()

            store = GroupStore(path)
            store.initialize()
            implicit_create = PROTOCOL.CreateRoomRequest.model_validate(legacy_create)
            implicit_add = PROTOCOL.AddAgentRequest.model_validate(legacy_add)
            create_command = group_plugin_api._create_room_command(implicit_create)
            add_command = group_plugin_api._add_agent_command(implicit_add)
            self.assertNotIn("maxReplyRounds", create_command)
            self.assertNotIn("replyWithoutMention", create_command["agents"][0])
            self.assertNotIn("replyWithoutMention", add_command)
            self.assertEqual(store.create_room(create_command), create_response)
            self.assertEqual(store.add_agent(room_id, add_command), add_response)

            explicit_create = PROTOCOL.CreateRoomRequest.model_validate(
                {**legacy_create, "requestId": request_id(), "maxReplyRounds": 3,
                 "agents": [{**legacy_create["agents"][0], "replyWithoutMention": False}]}
            )
            explicit_add = PROTOCOL.AddAgentRequest.model_validate(
                {**legacy_add, "requestId": request_id(), "replyWithoutMention": False}
            )
            self.assertEqual(
                group_plugin_api._create_room_command(explicit_create)["maxReplyRounds"],
                3,
            )
            self.assertFalse(
                group_plugin_api._create_room_command(explicit_create)["agents"][0][
                    "replyWithoutMention"
                ]
            )
            self.assertFalse(
                group_plugin_api._add_agent_command(explicit_add)["replyWithoutMention"]
            )

    def test_plugin_loader_injects_existing_agent_name_setting(self) -> None:
        probe = textwrap.dedent(
            """
            import json
            from pathlib import Path
            import sys
            import types

            dashboard = Path(sys.argv[1])
            sys.path.insert(0, str(dashboard))
            poller = types.ModuleType("poller")
            poller.start = lambda: None
            sys.modules["poller"] = poller
            import plugin_api
            plugin_api.store.load_agent_settings = lambda profile: {
                "profile": profile,
                "agentName": "现有名称",
                "updatedAt": 1,
            }
            group = plugin_api.group_plugin_api
            group.set_store_for_testing(None)
            instance = group._store_instance()
            instance.initialize()
            room = instance.create_room({
                "requestId": "11111111-1111-4111-8111-111111111111",
                "name": "群",
                "cwd": "",
                "agents": [{"profile": "default"}],
            })
            print(json.dumps(room, ensure_ascii=False))
            """
        )
        with tempfile.TemporaryDirectory() as hermes_home:
            environment = dict(os.environ)
            environment["HERMES_HOME"] = hermes_home
            result = subprocess.run(
                [sys.executable, "-c", probe, str(DASHBOARD_DIR)],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
        room = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(room["agents"][0]["displayName"], "现有名称")

    def test_cascade_freezes_reply_modes_across_rename_and_setting_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "agents": [
                        {"profile": "source"},
                        {"profile": "reviewer", "replyWithoutMention": True},
                        {"profile": "coder", "displayName": "开发"},
                    ],
                }
            )
            agents = {agent["profile"]: agent for agent in room["agents"]}
            source_run_id = self._insert_completed_source(
                store,
                room["id"],
                agents["source"]["id"],
                content="@开发 请继续",
                depth=0,
            )
            store.update_agent(
                room["id"],
                agents["coder"]["id"],
                {"requestId": request_id(), "displayName": "新开发"},
            )
            store.update_agent(
                room["id"],
                agents["reviewer"]["id"],
                {"requestId": request_id(), "replyWithoutMention": False},
            )
            result = store.complete_cascade(source_run_id)
            modes = {
                store.get_run(run_id)["agentId"]: store.get_run(run_id)["replyMode"]
                for run_id in result["runIds"]
            }
            self.assertEqual(
                modes,
                {agents["coder"]["id"]: "mentioned"},
            )

    def test_round_limit_and_unlimited_mode(self) -> None:
        for max_rounds, depth, expected in ((3, 2, 0), (-1, 20, 1)):
            with self.subTest(max_rounds=max_rounds), tempfile.TemporaryDirectory() as directory:
                store = GroupStore(Path(directory) / "group.db")
                store.initialize()
                room = store.create_room(
                    {
                        "requestId": request_id(),
                        "name": "研发群",
                        "cwd": "",
                        "maxReplyRounds": max_rounds,
                        "agents": [{"profile": "source"}, {"profile": "target"}],
                    }
                )
                agents = {agent["profile"]: agent for agent in room["agents"]}
                source_run_id = self._insert_completed_source(
                    store,
                    room["id"],
                    agents["source"]["id"],
                    content="@target",
                    depth=depth,
                )
                result = store.complete_cascade(source_run_id)
                self.assertEqual(result["runCount"], expected)

    def test_legacy_v1_pending_cascade_replays_after_schema_migration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "agents": [{"profile": "source"}, {"profile": "target"}],
                }
            )
            agents = {agent["profile"]: agent for agent in room["agents"]}
            source_run_id = self._insert_completed_source(
                store,
                room["id"],
                agents["source"]["id"],
                content="@target",
                depth=0,
            )
            with store.write_transaction() as connection:
                ledger = connection.execute(
                    "SELECT response_json FROM group_idempotency WHERE request_id = ?",
                    (store._cascade_request_id(source_run_id),),
                ).fetchone()
                current = json.loads(ledger["response_json"])
                legacy = {
                    "parseVersion": 1,
                    "sourceMessageId": current["sourceMessageId"],
                    "sourceRunId": source_run_id,
                    "state": "pending",
                    "targetAgentIds": [agents["target"]["id"]],
                    "version": 1,
                    "warnings": [],
                }
                connection.execute(
                    """UPDATE group_idempotency SET request_hash = ?, response_json = ?
                    WHERE request_id = ?""",
                    (
                        store._cascade_request_hash(source_run_id, parse_version=1),
                        store._canonical_json(legacy),
                        store._cascade_request_id(source_run_id),
                    ),
                )
            first = store.complete_cascade(source_run_id)
            second = store.complete_cascade(source_run_id)
            self.assertEqual(first, second)
            self.assertEqual(first["runCount"], 1)
            self.assertEqual(store.get_run(first["runIds"][0])["replyMode"], "mentioned")

    def test_automatic_no_reply_buffers_and_never_publishes(self) -> None:
        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(self, _run_id: str, **kwargs: object) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

        async def exercise() -> list[dict[str, object]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
            )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.delta",
                    payload={"text": "[[YAOYAO_"},
                ),
            )
            self.assertEqual(store.upserts, [])
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={"status": "complete", "text": "[[YAOYAO_NO_REPLY_V1]]"},
                ),
            )
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return store.upserts

        [upsert] = asyncio.run(exercise())
        self.assertEqual(upsert["content"], "")
        self.assertEqual(upsert["reasoning"], "")
        self.assertEqual(upsert["tool_state"], [])
        self.assertEqual(upsert["status"], "completed")
        self.assertFalse(upsert["publish"])

    def test_automatic_promotion_never_publishes_no_reply_marker(self) -> None:
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
                return {"id": str(uuid.uuid4())}

        async def exercise(
            content: str,
            reasoning: str,
            event_type: str,
            payload: dict[str, object],
        ) -> list[dict[str, object]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
                content=content,
                reasoning=reasoning,
                stream_dirty=True,
            )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type=event_type,
                    payload=payload,
                ),
            )
            return store.upserts

        promotions = (
            ("tool.start", {"tool_id": "tool-1", "name": "检索"}),
            ("approval.request", {"choices": ["once", "deny"]}),
            ("clarify.request", {"request_id": "clarify-1", "question": "请确认"}),
        )
        marker_cases = (
            ("[[YAOYAO_NO_REPLY_V1]]", ""),
            ("正文[[YAOYAO_NO_REPLY_V1]]尾", "正文尾"),
            ("正文[[YAOYAO_", "正文"),
            ("正文[[YAOYAO_尾", "正文尾"),
        )
        for event_type, payload in promotions:
            for buffered, expected in marker_cases:
                with self.subTest(event_type=event_type, buffered=buffered):
                    upserts = asyncio.run(exercise(buffered, "", event_type, payload))
                    self.assertTrue(upserts)
                    self.assertTrue(
                        all("[[YAOYAO" not in item["content"] for item in upserts)
                    )
                    self.assertTrue(
                        all(item["content"].strip() == expected for item in upserts)
                    )

            for buffered, expected in marker_cases:
                reasoning = buffered.replace("正文", "推理")
                expected_reasoning = expected.replace("正文", "推理")
                with self.subTest(event_type=event_type, reasoning=reasoning):
                    upserts = asyncio.run(
                        exercise("正常正文", reasoning, event_type, payload)
                    )
                    self.assertTrue(upserts)
                    self.assertTrue(
                        all("[[YAOYAO" not in item["reasoning"] for item in upserts)
                    )
                    self.assertTrue(
                        all(
                            item["reasoning"].strip() == expected_reasoning
                            for item in upserts
                        )
                    )

            normal = asyncio.run(exercise("正常正文", "正常推理", event_type, payload))
            self.assertTrue(normal)
            self.assertTrue(all(item["content"] == "正常正文" for item in normal))
            self.assertTrue(all(item["reasoning"] == "正常推理" for item in normal))
            self.assertTrue(all(item["publish"] for item in normal))

    def test_automatic_terminal_never_publishes_reasoning_marker(self) -> None:
        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(
                self, _run_id: str, **kwargs: object
            ) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

        async def exercise(
            status: str, reasoning: str
        ) -> list[dict[str, object]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
                automatic_published=status != "complete",
                content="正常正文",
                reasoning=reasoning,
                stream_dirty=True,
            )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={
                        "status": status,
                        "text": "正常正文",
                        "reasoning": reasoning,
                        "error": "失败",
                    },
                ),
            )
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return store.upserts

        marker_cases = (
            ("[[YAOYAO_NO_REPLY_V1]]", ""),
            ("推理[[YAOYAO_NO_REPLY_V1]]尾", "推理尾"),
            ("推理[[YAOYAO_", "推理"),
            ("推理[[YAOYAO_尾", "推理尾"),
        )
        for status in ("complete", "error", "interrupted"):
            for reasoning, expected in marker_cases:
                with self.subTest(status=status, reasoning=reasoning):
                    upserts = asyncio.run(exercise(status, reasoning))
                    self.assertTrue(upserts)
                    self.assertTrue(
                        all("[[YAOYAO" not in item["reasoning"] for item in upserts)
                    )
                    self.assertTrue(
                        all(item["reasoning"].strip() == expected for item in upserts)
                    )

    def test_mentioned_reply_preserves_no_reply_text_verbatim(self) -> None:
        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(
                self, _run_id: str, **kwargs: object
            ) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

        async def exercise() -> list[dict[str, object]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            content = "正文[[YAOYAO_尾"
            reasoning = "推理[[YAOYAO_NO_REPLY_V1]]尾"
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="mentioned",
            )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={
                        "status": "complete",
                        "text": content,
                        "reasoning": reasoning,
                    },
                ),
            )
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return store.upserts

        upserts = asyncio.run(exercise())
        self.assertTrue(upserts)
        self.assertEqual(upserts[-1]["content"], "正文[[YAOYAO_尾")
        self.assertEqual(upserts[-1]["reasoning"], "推理[[YAOYAO_NO_REPLY_V1]]尾")

    def test_unpublished_automatic_failure_discards_buffer_without_message_event(self) -> None:
        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(
                self, _run_id: str, **kwargs: object
            ) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

        async def exercise(status: str, content: str) -> tuple[object, list[dict[str, object]]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
                content=content,
                reasoning="内部推理",
                tool_state=[{"id": "internal", "status": "running"}],
                stream_dirty=True,
            )
            await orchestrator._apply_runtime_event(
                state,
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={"status": status, "text": content, "error": "失败"},
                ),
            )
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return state, store.upserts

        for status in ("error", "interrupted"):
            for content in ("未完成正文", "正文[[YAOYAO_NO_REPLY_V1]]尾", "[[YAOYAO_"):
                with self.subTest(status=status, content=content):
                    state, upserts = asyncio.run(exercise(status, content))
                    self.assertFalse(state.automatic_published)
                    self.assertEqual(len(upserts), 1)
                    self.assertEqual(upserts[0]["content"], "")
                    self.assertEqual(upserts[0]["reasoning"], "")
                    self.assertEqual(upserts[0]["tool_state"], [])
                    self.assertFalse(upserts[0]["publish"])

    def test_hidden_queued_message_blocks_context_watermark_until_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "乱序群",
                    "cwd": "",
                    "agents": [
                        {"profile": "slow", "replyWithoutMention": True},
                        {"profile": "fast", "replyWithoutMention": True},
                        {"profile": "observer"},
                    ],
                }
            )
            agents = {agent["profile"]: agent for agent in room["agents"]}
            first = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="并行开始",
                mention_agent_ids=[],
            )
            self.assertEqual(len(first["runs"]), 2)
            with store.connection() as connection:
                connection.execute(
                    "UPDATE group_agents SET reply_without_mention = 0 WHERE room_id = ?",
                    (room["id"],),
                )
                response_seqs = {
                    run["id"]: int(
                        connection.execute(
                            "SELECT seq FROM group_messages WHERE id = ?",
                            (run["responseMessageId"],),
                        ).fetchone()["seq"]
                    )
                    for run in first["runs"]
                }
            slow_id, fast_id = sorted(response_seqs, key=response_seqs.get)
            claimed = {
                run["id"]: run
                for _ in range(2)
                if (run := store.claim_next_runnable_run()) is not None
            }
            self.assertEqual(set(claimed), {slow_id, fast_id})

            def bind(run_id: str, label: str, expected: str | None = None) -> tuple[str, str]:
                stored, runtime = f"{label}-stored", f"{label}-runtime"
                store.bind_run_session(
                    run_id,
                    expected_stored_session_id=expected,
                    stored_session_id=stored,
                    runtime_session_id=runtime,
                )
                return stored, runtime

            slow_stored, slow_runtime = bind(slow_id, "slow")
            fast_stored, fast_runtime = bind(fast_id, "fast")
            store.upsert_agent_message(
                fast_id,
                content="先到正文",
                reasoning="",
                tool_state=[],
                status="completed",
                publish=True,
            )
            store.settle_run(
                fast_id,
                runtime_session_id=fast_runtime,
                expected_stored_session_id=fast_stored,
                stored_session_id=fast_stored,
                outcome="completed",
            )

            observer_first = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="第一次检查",
                mention_agent_ids=[agents["observer"]["id"]],
            )["runs"][0]
            claimed_observer = store.claim_next_runnable_run()
            self.assertEqual(claimed_observer["id"], observer_first["id"])
            observer_stored, observer_runtime = bind(observer_first["id"], "observer-1")
            projection = store.read_run_projection(observer_first["id"])
            self.assertEqual(projection["throughSeq"], 1)
            store.advance_run_context(
                observer_first["id"],
                runtime_session_id=observer_runtime,
                expected_context_seq=0,
                through_seq=projection["throughSeq"],
            )
            store.settle_run(
                observer_first["id"],
                runtime_session_id=observer_runtime,
                expected_stored_session_id=observer_stored,
                stored_session_id=observer_stored,
                outcome="failed",
                error="测试结束",
            )

            store.upsert_agent_message(
                slow_id,
                content="迟到正文",
                reasoning="",
                tool_state=[],
                status="completed",
                publish=True,
            )
            store.settle_run(
                slow_id,
                runtime_session_id=slow_runtime,
                expected_stored_session_id=slow_stored,
                stored_session_id=slow_stored,
                outcome="completed",
            )

            observer_second = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="第二次检查",
                mention_agent_ids=[agents["observer"]["id"]],
            )["runs"][0]
            claimed_observer = store.claim_next_runnable_run()
            self.assertEqual(claimed_observer["id"], observer_second["id"])
            bind(
                observer_second["id"],
                "observer-2",
                expected=observer_stored,
            )
            future = store.read_run_projection(observer_second["id"])
            self.assertIn("迟到正文", [message["content"] for message in future["messages"]])

    def test_hidden_automatic_failure_emits_run_only_and_replays_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = GroupStore(Path(directory) / "group.db")
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "研发群",
                    "cwd": "",
                    "agents": [
                        {"profile": "host"},
                        {"profile": "reviewer", "replyWithoutMention": True},
                    ],
                }
            )
            created = store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="普通消息",
                mention_agent_ids=[],
            )
            reviewer = next(
                agent for agent in room["agents"] if agent["profile"] == "reviewer"
            )
            run = next(
                item for item in created["runs"] if item["agentId"] == reviewer["id"]
            )
            before = store.latest_cursor()
            first = store.transition_run(run["id"], "failed", error="失败")
            second = store.transition_run(run["id"], "failed", error="失败")
            self.assertEqual(first, second)
            self.assertEqual(first["replyMode"], "automatic")
            self.assertNotIn("bufferedResponse", first)
            events = store.events_after(before, 20)
            self.assertTrue(
                any(event["eventType"] == "run.updated" for event in events)
            )
            self.assertFalse(
                any(event["eventType"] == "message.upsert" for event in events)
            )
            self.assertEqual(
                [message["senderId"] for message in store.list_messages(room["id"])],
                [
                    "human",
                    next(agent["id"] for agent in room["agents"] if agent["isHost"]),
                ],
            )

    def test_automatic_consumer_waits_without_zero_timeout_and_accepts_terminal(self) -> None:
        class CountingQueue(asyncio.Queue):
            def __init__(self) -> None:
                super().__init__()
                self.get_calls = 0

            async def get(self):  # type: ignore[override]
                self.get_calls += 1
                return await super().get()

        class FakeStore:
            def __init__(self) -> None:
                self.upserts: list[dict[str, object]] = []

            def upsert_agent_message(self, _run_id: str, **kwargs: object) -> dict[str, object]:
                self.upserts.append(dict(kwargs))
                return dict(kwargs)

        async def exercise() -> tuple[int, list[dict[str, object]]]:
            store = FakeStore()
            orchestrator = ORCHESTRATOR.GroupOrchestrator(store)
            queue = CountingQueue()
            state = ORCHESTRATOR._RuntimeState(
                run_id=str(uuid.uuid4()),
                room_id=str(uuid.uuid4()),
                topic_id=str(uuid.uuid4()),
                agent_id=str(uuid.uuid4()),
                runtime_id="runtime",
                generation=1,
                expected_stored_id=None,
                session_stored_id="stored",
                expected_context_seq=0,
                through_seq=0,
                reply_mode="automatic",
                pending_events=queue,
                prompt_committed=True,
            )
            orchestrator._runtime_states[state.runtime_id] = (state.generation, state)
            state.prompt_ready.set()
            task = asyncio.create_task(orchestrator._consume_runtime_events(state))
            await queue.put(
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.delta",
                    payload={"text": "正常"},
                )
            )
            await asyncio.sleep(0.12)
            calls_after_idle = queue.get_calls
            await queue.put(
                ORCHESTRATOR._GatewayEvent(
                    runtime_id="runtime",
                    generation=1,
                    event_type="message.complete",
                    payload={"status": "complete", "text": "正常回复"},
                )
            )
            for _ in range(100):
                if store.upserts:
                    break
                await asyncio.sleep(0.002)
            state.finished.set()
            await queue.put(None)
            await asyncio.wait_for(task, timeout=1)
            if state.grace_task is not None:
                state.grace_task.cancel()
                await asyncio.gather(state.grace_task, return_exceptions=True)
            return calls_after_idle, store.upserts

        calls, upserts = asyncio.run(exercise())
        self.assertLessEqual(calls, 4)
        self.assertEqual(upserts[-1]["content"], "正常回复")
        self.assertTrue(upserts[-1]["publish"])

    @staticmethod
    def _insert_completed_source(
        store: GroupStore,
        room_id: str,
        agent_id: str,
        *,
        content: str,
        depth: int,
    ) -> str:
        message_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
        with store.write_transaction() as connection:
            now = 10.0
            store._ensure_topic(connection, room_id, message_id, content, now)
            connection.execute(
                """INSERT INTO group_messages
                (id, room_id, topic_id, sender_kind, sender_id, sender_name, root_message_id,
                 reply_to_message_id, client_message_id, content, reasoning,
                 tool_state_json, status, error, visible, created_at, updated_at)
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
                (id, room_id, topic_id, agent_id, trigger_message_id, response_message_id,
                 root_message_id, depth, reply_mode, status, runtime_session_id,
                 error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mentioned', 'completed', NULL, '', ?, ?)""",
                (
                    run_id,
                    room_id,
                    message_id,
                    agent_id,
                    message_id,
                    message_id,
                    message_id,
                    depth,
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

    def _assert_v2_value_corruption_fails_closed(self, mutation: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "group.db"
            store = GroupStore(path)
            store.initialize()
            room = store.create_room(
                {
                    "requestId": request_id(),
                    "name": "值域门禁",
                    "cwd": "",
                    "agents": [{"profile": "default"}],
                }
            )
            [agent] = room["agents"]
            store.create_human_message(
                room["id"],
                request_id=request_id(),
                client_message_id=request_id(),
                content="触发",
                mention_agent_ids=[agent["id"]],
            )
            with store.connection() as connection:
                connection.execute(mutation)
            with self.assertRaises(STORE_MODULE.GroupStoreError):
                GroupStore(path).initialize()

    @staticmethod
    def _create_v1_database(path: Path) -> None:
        connection = sqlite3.connect(path)
        statements = (
            "CREATE TABLE group_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE group_rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE group_agents (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE, profile TEXT NOT NULL, display_name TEXT NOT NULL, display_name_key TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', stored_session_id TEXT, last_context_message_seq INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE(room_id, profile), UNIQUE(room_id, display_name_key))",
            "CREATE TABLE group_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE, sender_kind TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, root_message_id TEXT NOT NULL, reply_to_message_id TEXT, client_message_id TEXT UNIQUE, content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', tool_state_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)",
            "CREATE TABLE group_agent_runs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, trigger_message_id TEXT NOT NULL, response_message_id TEXT NOT NULL, root_message_id TEXT NOT NULL, depth INTEGER NOT NULL, status TEXT NOT NULL, runtime_session_id TEXT, error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)",
            "CREATE TABLE group_interactions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, resolved_at REAL)",
            "CREATE TABLE group_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, room_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL)",
            "CREATE TABLE group_idempotency (request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at REAL NOT NULL)",
        )
        for statement in statements:
            connection.execute(statement)
        room_id, agent_id, message_id, run_id = (str(uuid.uuid4()) for _ in range(4))
        connection.executemany(
            "INSERT INTO group_meta(key,value) VALUES (?,?)",
            (("schema_version", "1"), ("journal_epoch", "11111111-1111-4111-8111-111111111111")),
        )
        connection.execute("INSERT INTO group_rooms VALUES (?,?,?,?,?,?)", (room_id, "旧群", "", 1.0, 1.0, 0))
        connection.execute("INSERT INTO group_agents VALUES (?,?,?,?,?,?,?,?,?,?,?)", (agent_id, room_id, "default", "旧名", "旧名", "", None, 0, 1, 1.0, 1.0))
        connection.execute("INSERT INTO group_messages VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (message_id, room_id, "human", "human", "你", message_id, None, str(uuid.uuid4()), "旧消息", "", "[]", "completed", "", 1.0, 1.0))
        connection.execute("INSERT INTO group_agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (run_id, room_id, agent_id, message_id, message_id, message_id, 0, "completed", None, "", 1.0, 1.0))
        connection.execute("INSERT INTO group_idempotency VALUES (?,?,?,?,?)", (str(uuid.uuid4()), "test", "hash", json.dumps({}), 1.0))
        connection.commit()
        connection.close()


if __name__ == "__main__":
    unittest.main()
