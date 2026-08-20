from __future__ import annotations

import re
import unittest
from pathlib import Path


class DashboardFrontendContractTests(unittest.TestCase):
    def test_sdk_selects_use_value_callback(self) -> None:
        source = (
            Path(__file__).resolve().parents[1] / "dist" / "index.js"
        ).read_text(encoding="utf-8")
        select_blocks = re.findall(r"h\(Select, \{(.*?)\},", source, flags=re.S)

        self.assertGreater(len(select_blocks), 0)
        self.assertFalse(
            [block for block in select_blocks if "onChange:" in block],
            "Hermes SDK Select requires onValueChange(value), not onChange(event)",
        )
        self.assertTrue(
            all("onValueChange:" in block for block in select_blocks),
            "Every Hermes SDK Select must expose its value callback",
        )


if __name__ == "__main__":
    unittest.main()
