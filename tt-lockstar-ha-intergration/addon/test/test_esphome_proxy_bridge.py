"""Tests for the ESPHome raw BLE advertisement decoder."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from esphome_proxy_bridge import Bridge, Proxy, mac_to_int, parse_raw_advertisement  # noqa: E402


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

    def test_writes_command_fragments_in_one_ordered_bridge_request(self):
        class FakeClient:
            def __init__(self):
                self.writes = []

            async def bluetooth_gatt_write(self, address, handle, data, response):
                self.writes.append((address, handle, bytes(data), response))

        client = FakeClient()
        proxy = Proxy("test:6053", "test", 6053, client=client, connected=True)
        bridge = Bridge([])
        address = mac_to_int("DC:47:11:85:94:2F")
        bridge.active[address] = proxy

        result = __import__("asyncio").run(bridge.handle({
            "action": "write_fragments",
            "address": "DC:47:11:85:94:2F",
            "handle": 12,
            "data": ["01" * 20, "02" * 7],
            "response": False,
            "delay_ms": 0,
        }))

        self.assertEqual(result, 2)
        self.assertEqual([item[2] for item in client.writes], [bytes([1]) * 20, bytes([2]) * 7])
        self.assertTrue(all(item[3] is False for item in client.writes))

    def test_clears_only_matching_notification_callbacks(self):
        address = mac_to_int("DC:47:11:85:94:2F")
        other_address = mac_to_int("11:22:33:44:55:66")
        removed = []
        bridge = Bridge([])
        bridge.notification_stops[(address, 12)] = (None, lambda: removed.append(12))
        bridge.notification_stops[(address, 15)] = (None, lambda: removed.append(15))
        bridge.notification_stops[(other_address, 12)] = (None, lambda: removed.append(99))

        count = bridge.clear_notification_subscriptions(address, "test disconnect")

        self.assertEqual(count, 2)
        self.assertEqual(removed, [12, 15])
        self.assertNotIn((address, 12), bridge.notification_stops)
        self.assertNotIn((address, 15), bridge.notification_stops)
        self.assertIn((other_address, 12), bridge.notification_stops)

    def test_reissues_start_notify_after_disconnect_cleanup(self):
        class FakeClient:
            def __init__(self):
                self.starts = 0
                self.callback_removals = 0

            async def bluetooth_gatt_start_notify(self, address, handle, callback):
                del address, handle, callback
                self.starts += 1

                async def stop_remote_notify():
                    return None

                def remove_local_callback():
                    self.callback_removals += 1

                return stop_remote_notify, remove_local_callback

        async def run_test():
            client = FakeClient()
            proxy = Proxy("test:6053", "test", 6053, client=client, connected=True, name="test")
            bridge = Bridge([])
            address = mac_to_int("DC:47:11:85:94:2F")
            bridge.active[address] = proxy
            request = {
                "action": "subscribe",
                "address": "DC:47:11:85:94:2F",
                "handle": 12,
            }

            await bridge.handle(request)
            bridge.clear_notification_subscriptions(address, "test disconnect")
            await bridge.handle(request)

            return client, bridge, address

        client, bridge, address = __import__("asyncio").run(run_test())
        self.assertEqual(client.starts, 2)
        self.assertEqual(client.callback_removals, 1)
        self.assertIn((address, 12), bridge.notification_stops)

    def test_routes_home_assistant_observation_to_matching_proxy(self):
        craft = Proxy(
            "192.168.1.238:6053",
            "192.168.1.238",
            6053,
            name="craft-door-proxy",
            source="EC:C9:FF:8F:AE:82",
            connected=True,
        )
        bedroom = Proxy(
            "192.168.1.55:6053",
            "192.168.1.55",
            6053,
            name="bedroom-proxy",
            source="1C:69:20:3F:D9:C8",
            connected=True,
        )
        bridge = Bridge([])
        bridge.proxies = [craft, bedroom]

        result = bridge.observe_advertisement({
            "address": "DC:47:11:85:94:2F",
            "source": "EC:C9:FF:8F:AE:82",
            "rssi": -65,
            "address_type": 0,
        })

        address = mac_to_int("DC:47:11:85:94:2F")
        self.assertTrue(result["matched"])
        self.assertEqual(result["proxy"], "craft-door-proxy")
        self.assertEqual(craft.advertisements[address][1:], (-65, 0))
        self.assertNotIn(address, bedroom.advertisements)

    def test_reuses_cached_gatt_services_after_disconnect(self):
        class FakeClient:
            def __init__(self):
                self.connect_cache_flags = []
                self.service_reads = 0

            async def bluetooth_device_connect(
                self, address, callback, timeout, feature_flags, has_cache, address_type
            ):
                del address, timeout, feature_flags, address_type
                self.connect_cache_flags.append(has_cache)
                callback(True, 0 if has_cache else 23, 0)
                return lambda: None

            async def bluetooth_device_disconnect(self, address, timeout):
                del address, timeout

            async def bluetooth_gatt_get_services(self, address):
                del address
                self.service_reads += 1
                characteristic = SimpleNamespace(
                    uuid="1912", handle=12, properties=0x10, descriptors=[]
                )
                service = SimpleNamespace(
                    uuid="1910", handle=1, characteristics=[characteristic]
                )
                return SimpleNamespace(services=[service])

        async def run_test():
            client = FakeClient()
            proxy = Proxy("test:6053", "test", 6053, client=client, connected=True, name="test")
            bridge = Bridge([])
            bridge.proxies = [proxy]
            request = {"address": "DC:47:11:85:94:2F", "timeout": 8}

            first = await bridge.connect_device(request)
            first_services = await bridge.handle({"action": "services", "address": request["address"]})
            await bridge.handle({"action": "disconnect", "address": request["address"]})
            second = await bridge.connect_device(request)
            second_services = await bridge.handle({"action": "services", "address": request["address"]})
            return client, first, second, first_services, second_services

        client, first, second, first_services, second_services = __import__("asyncio").run(run_test())
        self.assertEqual(client.connect_cache_flags, [False, True])
        self.assertEqual(client.service_reads, 1)
        self.assertFalse(first["cached_gatt"])
        self.assertTrue(second["cached_gatt"])
        self.assertEqual(first["mtu"], 23)
        self.assertEqual(second["mtu"], 23)
        self.assertEqual(first_services, second_services)

    def test_cached_connect_failure_retries_uncached(self):
        class FakeClient:
            def __init__(self):
                self.connect_cache_flags = []
                self.cache_clears = 0

            async def bluetooth_device_connect(
                self, address, callback, timeout, feature_flags, has_cache, address_type
            ):
                del address, timeout, feature_flags, address_type
                self.connect_cache_flags.append(has_cache)
                if has_cache:
                    raise RuntimeError("stale handles")
                callback(True, 23, 0)
                return lambda: None

            async def bluetooth_device_clear_cache(self, address):
                del address
                self.cache_clears += 1
                return SimpleNamespace(success=True, error=0)

        async def run_test():
            client = FakeClient()
            proxy = Proxy("test:6053", "test", 6053, client=client, connected=True, name="test")
            bridge = Bridge([])
            bridge.proxies = [proxy]
            address = mac_to_int("DC:47:11:85:94:2F")
            bridge.gatt_cache[address] = [{"uuid": "1910", "handle": 1, "characteristics": []}]
            bridge.mtu_cache[address] = 23
            result = await bridge.connect_device({"address": "DC:47:11:85:94:2F", "timeout": 8})
            return client, bridge, address, result

        client, bridge, address, result = __import__("asyncio").run(run_test())
        self.assertEqual(client.connect_cache_flags, [True, False])
        self.assertEqual(client.cache_clears, 1)
        self.assertNotIn(address, bridge.gatt_cache)
        self.assertFalse(result["cached_gatt"])


if __name__ == "__main__":
    unittest.main()
