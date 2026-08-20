from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


DASHBOARD_DIR = Path(__file__).resolve().parents[1]


class GroupMergeContractTests(unittest.TestCase):
    def test_group_routes_share_yaoyao_plugin_and_lifespan(self) -> None:
        probe = textwrap.dedent(
            """
            import json
            from pathlib import Path
            import sys
            import types

            from fastapi import FastAPI
            from fastapi.testclient import TestClient

            dashboard_dir = Path(sys.argv[1])
            sys.path.insert(0, str(dashboard_dir))

            poller = types.ModuleType("poller")
            poller.start = lambda: None
            sys.modules["poller"] = poller
            unrelated_group_api = types.ModuleType("group_plugin_api")
            sys.modules["group_plugin_api"] = unrelated_group_api

            import plugin_api
            from hermes_cli import plugins_cmd, web_server

            lifecycle = []

            class FakeOrchestrator:
                async def start(self):
                    lifecycle.append("start")

                async def shutdown(self):
                    lifecycle.append("shutdown")

            class FakeStore:
                def initialize(self):
                    return None

                def journal_epoch(self):
                    return "11111111-1111-4111-8111-111111111111"

                def latest_cursor(self):
                    return 0

            group_api = plugin_api.group_plugin_api
            original_plugins = web_server._get_dashboard_plugins
            original_enabled = plugins_cmd._get_enabled_set
            original_disabled = plugins_cmd._get_disabled_set
            web_server._get_dashboard_plugins = lambda: [
                {"name": "yaoyao", "source": "user"}
            ]
            plugins_cmd._get_enabled_set = lambda: {"yaoyao"}
            plugins_cmd._get_disabled_set = lambda: set()
            enabled_state = group_api._plugin_runtime_enabled()
            plugins_cmd._get_disabled_set = lambda: {"yaoyao"}
            disabled_state = group_api._plugin_runtime_enabled()
            web_server._get_dashboard_plugins = original_plugins
            plugins_cmd._get_enabled_set = original_enabled
            plugins_cmd._get_disabled_set = original_disabled

            group_api.set_store_for_testing(FakeStore())
            group_api.set_orchestrator_factory_for_testing(
                lambda _store: FakeOrchestrator()
            )

            app = FastAPI()
            app.include_router(
                plugin_api.router,
                prefix="/api/plugins/yaoyao",
            )
            with TestClient(app) as client:
                existing_files_status = client.get(
                    "/api/plugins/yaoyao/files"
                ).status_code
                existing_voice_status = client.get(
                    "/api/plugins/yaoyao/voice/settings"
                ).status_code
                capabilities_status = client.get(
                    "/api/plugins/yaoyao/v1/capabilities"
                ).status_code
                lifecycle.append("ready")

            stream = group_api._stream_module
            stream.PLUGIN_STATE_POLL_SECONDS = 0
            epoch = "11111111-1111-4111-8111-111111111111"

            class StreamStore:
                def journal_epoch(self):
                    return epoch

                def cursor_status(self, _epoch, _cursor):
                    return "ok"

                def events_after(self, _cursor, _limit):
                    return []

            class StreamSocket:
                query_params = {"epoch": epoch, "cursor": "0"}

                def __init__(self):
                    self.frames = []
                    self.close_codes = []

                async def accept(self):
                    return None

                async def send_json(self, frame):
                    self.frames.append(frame)

                async def close(self, code, reason=None):
                    self.close_codes.append(code)

                async def receive(self):
                    import asyncio
                    await asyncio.Future()

            availability = iter([True, False])
            socket = StreamSocket()
            import asyncio
            asyncio.run(
                stream.stream_authorized_group_events(
                    socket,
                    lambda: StreamStore(),
                    availability_provider=lambda: next(availability, False),
                )
            )

            orchestrator_module = __import__(
                f"{group_api._LOCAL_PACKAGE}.group_orchestrator",
                fromlist=["GroupOrchestrator"],
            )
            orchestrator_module._WORK_DISABLED_RETRY_SECONDS = 0.01

            class SchedulerStore:
                def __init__(self):
                    self.cascade_calls = 0
                    self.claim_calls = 0

                def initialize(self):
                    return None

                def recover_after_restart(self):
                    return []

                def list_pending_cascades(self, *, limit):
                    self.cascade_calls += 1
                    return {"items": [], "nextCursor": None}

                def claim_next_runnable_run(self):
                    self.claim_calls += 1
                    return None

            class SchedulerTransport:
                def drain(self, _timeout):
                    return None

            class SchedulerGateway:
                transport = SchedulerTransport()

                def shutdown(self):
                    return None

            async def exercise_scheduler_gate():
                scheduler_store = SchedulerStore()
                work_enabled = [False]
                orchestrator = orchestrator_module.GroupOrchestrator(
                    scheduler_store,
                    gateway_factory=lambda _callback: SchedulerGateway(),
                    work_enabled=lambda: work_enabled[0],
                )
                await orchestrator.start()
                await asyncio.sleep(0.04)
                disabled_calls = [
                    scheduler_store.cascade_calls,
                    scheduler_store.claim_calls,
                ]
                work_enabled[0] = True
                for _ in range(100):
                    if (
                        scheduler_store.cascade_calls > 0
                        and scheduler_store.claim_calls > 0
                    ):
                        break
                    await asyncio.sleep(0.005)
                enabled_calls = [
                    scheduler_store.cascade_calls,
                    scheduler_store.claim_calls,
                ]
                await orchestrator.shutdown()
                return disabled_calls, enabled_calls

            disabled_calls, enabled_calls = asyncio.run(exercise_scheduler_gate())

            class DisabledSocket:
                def __init__(self):
                    self.close_codes = []

                async def close(self, code, reason=None):
                    self.close_codes.append(code)

            original_upgrade_allowed = stream.websocket_upgrade_allowed
            original_runtime_enabled = group_api._plugin_runtime_enabled
            stream.websocket_upgrade_allowed = lambda _websocket: (True, 1000)
            group_api._plugin_runtime_enabled = lambda: False
            disabled_socket = DisabledSocket()
            asyncio.run(group_api.stream_events(disabled_socket))
            stream.websocket_upgrade_allowed = original_upgrade_allowed
            group_api._plugin_runtime_enabled = original_runtime_enabled

            print(json.dumps({
                "paths": sorted(
                    getattr(route, "path", "")
                    for route in plugin_api.router.routes
                ),
                "lifecycle": lifecycle,
                "storePath": str(group_api.GroupStore.from_environment().path),
                "moduleIsPrivate": group_api is not unrelated_group_api,
                "pluginGate": [enabled_state, disabled_state],
                "streamFrames": socket.frames,
                "streamCloseCodes": socket.close_codes,
                "disabledWorkCalls": disabled_calls,
                "enabledWorkCalls": enabled_calls,
                "disabledConnectCloseCodes": disabled_socket.close_codes,
                "statuses": [
                    existing_files_status,
                    existing_voice_status,
                    capabilities_status,
                ],
            }))
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

        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIn("/files", payload["paths"])
        self.assertIn("/voice/settings", payload["paths"])
        self.assertIn("/v1/capabilities", payload["paths"])
        self.assertIn("/v1/events", payload["paths"])
        self.assertTrue(payload["moduleIsPrivate"])
        self.assertEqual(payload["pluginGate"], [True, False])
        self.assertEqual(payload["streamFrames"][0]["type"], "group.ready")
        self.assertEqual(payload["streamCloseCodes"], [4404])
        self.assertEqual(payload["disabledWorkCalls"], [0, 0])
        self.assertGreater(payload["enabledWorkCalls"][0], 0)
        self.assertGreater(payload["enabledWorkCalls"][1], 0)
        self.assertEqual(payload["disabledConnectCloseCodes"], [4404])
        self.assertEqual(payload["statuses"], [200, 200, 200])
        self.assertEqual(payload["lifecycle"], ["start", "ready", "shutdown"])
        self.assertEqual(
            payload["storePath"],
            str(Path(hermes_home) / "plugins" / "yaoyao" / "data" / "group-chat.db"),
        )


if __name__ == "__main__":
    unittest.main()
