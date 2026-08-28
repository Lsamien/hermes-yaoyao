from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


DASHBOARD_DIR = Path(__file__).resolve().parents[1]
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

import store  # noqa: E402


class DuplexVoiceSettingsContractTests(unittest.TestCase):
    def test_public_settings_mask_the_key_and_removed_current_voice_falls_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings_path = root / "duplex_voice.json"
            with (
                patch.object(store, "DEFAULT_DATA_ROOT", root),
                patch.object(store, "_DUPLEX_VOICE_FILE", settings_path),
            ):
                store.save_duplex_voice({
                    "apiKey": "top-secret-key",
                    "voices": [
                        {"id": "voice-a", "name": "音色 A"},
                        {"id": "voice-b", "name": "音色 B"},
                    ],
                    "currentVoiceId": "voice-b",
                })
                public = store.public_duplex_voice()
                self.assertTrue(public["hasApiKey"])
                self.assertNotIn("apiKey", public)
                self.assertNotIn("top-secret-key", str(public))
                self.assertEqual(store.runtime_duplex_voice()["apiKey"], "top-secret-key")

                updated = store.save_duplex_voice({
                    "voices": [{"id": "voice-a", "name": "音色 A"}],
                })
                self.assertEqual(updated["currentVoiceId"], "voice-a")
                self.assertEqual(updated["apiKey"], "top-secret-key")


if __name__ == "__main__":
    unittest.main()
