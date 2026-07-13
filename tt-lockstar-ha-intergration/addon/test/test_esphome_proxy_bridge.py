"""Tests for the ESPHome raw BLE advertisement decoder."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from esphome_proxy_bridge import parse_raw_advertisement  # noqa: E402


class RawAdvertisementTests(unittest.TestCase):
    def test_decodes_captured_m302_wake_packet(self):
        raw = SimpleNamespace(
            address=0xDC471185942F,
            address_type=0,
            rssi=-80,
            data=bytes.fromhex(
                "020106020aba0302101912ff0503023064b000f4f953652f94851147dc"
                "0c094d3330325f326639343835051214002400"
            ),
        )

        result = parse_raw_advertisement(raw)

        self.assertEqual(result["address"], 0xDC471185942F)
        self.assertEqual(result["rssi"], -80)
        self.assertEqual(result["name"], "M302_2f9485")
        self.assertIn("1910", result["service_uuids"])
        self.assertEqual(result["manufacturer_data"][0x0305].hex(), "023064b000f4f953652f94851147dc")
        self.assertEqual(result["service_data"], {})


if __name__ == "__main__":
    unittest.main()
