#!/usr/bin/env python3
"""JSON-lines bridge between Node.js and local ESPHome Bluetooth proxies.

Standard output is reserved for protocol messages. Diagnostics go to stderr.
The bridge never talks to TTLock Cloud; it uses the ESPHome native API only.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any

from aioesphomeapi import APIClient
from aioesphomeapi.model import BluetoothProxyFeature, BluetoothScannerMode


def log(message: str) -> None:
    print(f"[ESPHome proxy bridge] {message}", file=sys.stderr, flush=True)


def mac_to_int(address: str) -> int:
    return int(address.replace(":", "").replace("-", ""), 16)


def int_to_mac(address: int) -> str:
    value = f"{address:012X}"
    return ":".join(value[index : index + 2] for index in range(0, 12, 2))


def parse_endpoint(value: str) -> tuple[str, int]:
    value = value.strip()
    if not value:
        raise ValueError("empty ESPHome proxy endpoint")
    if value.count(":") == 1:
        host, port = value.rsplit(":", 1)
        return host, int(port)
    return value, 6053


@dataclass
class Proxy:
    endpoint: str
    host: str
    port: int
    client: APIClient | None = None
    name: str = ""
    connected: bool = False
    feature_flags: int = 0
    free: int = 0
    limit: int = 0
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    advertisements: dict[int, tuple[float, int, int]] = field(default_factory=dict)
    unsubscribers: list[Any] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "name": self.name or self.host,
            "connected": self.connected,
            "feature_flags": self.feature_flags,
            "free": self.free,
            "limit": self.limit,
        }


class Bridge:
    def __init__(self, endpoints: list[str]) -> None:
        self.proxies = [Proxy(endpoint, *parse_endpoint(endpoint)) for endpoint in endpoints]
        self.output_lock = asyncio.Lock()
        self.tasks: list[asyncio.Task[Any]] = []
        self.active: dict[int, Proxy] = {}
        self.connection_unsubscribers: dict[int, Any] = {}
        self.notification_stops: dict[tuple[int, int], tuple[Any, Any]] = {}
        self.ready_emitted = False
        self.shutting_down = False

    async def emit(self, payload: dict[str, Any]) -> None:
        async with self.output_lock:
            print(json.dumps(payload, separators=(",", ":")), flush=True)

    async def start(self) -> None:
        for proxy in self.proxies:
            self.tasks.append(asyncio.create_task(self.proxy_worker(proxy)))

    async def proxy_worker(self, proxy: Proxy) -> None:
        delay = 1.0
        while not self.shutting_down:
            proxy.stop_event = asyncio.Event()
            client = APIClient(
                proxy.host,
                proxy.port,
                None,
                client_info="TT-LockStar local ESPHome proxy bridge",
            )
            proxy.client = client

            async def on_stop(expected_disconnect: bool) -> None:
                proxy.connected = False
                proxy.stop_event.set()
                await self.emit({
                    "type": "proxy_state",
                    "proxy": proxy.summary(),
                    "expected_disconnect": expected_disconnect,
                })

            try:
                await client.connect(on_stop=on_stop, login=True, log_errors=False)
                info = await client.device_info()
                proxy.name = info.name
                proxy.feature_flags = int(info.bluetooth_proxy_feature_flags)
                required = int(
                    BluetoothProxyFeature.ACTIVE_CONNECTIONS
                    | BluetoothProxyFeature.REMOTE_CACHING
                )
                if proxy.feature_flags & required != required:
                    raise RuntimeError(
                        f"{proxy.name} lacks active connections or remote GATT caching "
                        f"(feature flags {proxy.feature_flags})"
                    )
                scanner_control = int(BluetoothProxyFeature.FEATURE_STATE_AND_MODE)
                if proxy.feature_flags & scanner_control != scanner_control:
                    raise RuntimeError(
                        f"{proxy.name} cannot switch its Bluetooth scanner to active mode "
                        f"(feature flags {proxy.feature_flags})"
                    )

                # TTLock wake advertisements may be too short to discover reliably with
                # passive scanning. ESPHome keeps this mode until another API subscriber
                # changes it, so assert it each time this bridge reconnects.
                client.bluetooth_scanner_set_mode(BluetoothScannerMode.ACTIVE)

                def on_advertisement(advertisement: Any) -> None:
                    now = time.monotonic()
                    proxy.advertisements[advertisement.address] = (
                        now,
                        advertisement.rssi,
                        advertisement.address_type,
                    )
                    asyncio.create_task(self.emit({
                        "type": "advertisement",
                        "proxy": proxy.name,
                        "device": {
                            "address": int_to_mac(advertisement.address),
                            "address_type": advertisement.address_type,
                            "rssi": advertisement.rssi,
                            "name": advertisement.name,
                            "service_uuids": advertisement.service_uuids,
                            "service_data": {
                                key: value.hex()
                                for key, value in advertisement.service_data.items()
                            },
                            "manufacturer_data": {
                                str(key): value.hex()
                                for key, value in advertisement.manufacturer_data.items()
                            },
                        },
                    }))

                def on_connections_free(free: int, limit: int, allocated: list[int]) -> None:
                    proxy.free = free
                    proxy.limit = limit
                    asyncio.create_task(self.emit({
                        "type": "proxy_slots",
                        "proxy": proxy.name,
                        "free": free,
                        "limit": limit,
                        "allocated": [int_to_mac(address) for address in allocated],
                    }))

                proxy.unsubscribers = [
                    client.subscribe_bluetooth_le_advertisements(on_advertisement),
                    client.subscribe_bluetooth_connections_free(on_connections_free),
                ]
                proxy.connected = True
                delay = 1.0
                log(
                    f"connected to {proxy.name} at {proxy.endpoint}; "
                    f"Bluetooth proxy flags={proxy.feature_flags}; active scanning requested"
                )
                await self.emit({"type": "proxy_state", "proxy": proxy.summary()})
                if not self.ready_emitted:
                    self.ready_emitted = True
                    await self.emit({
                        "type": "ready",
                        "proxies": [item.summary() for item in self.proxies],
                    })
                await proxy.stop_event.wait()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # pylint: disable=broad-except
                log(f"{proxy.endpoint}: {type(error).__name__}: {error}")
                await self.emit({
                    "type": "proxy_error",
                    "proxy": proxy.summary(),
                    "error": str(error),
                })
            finally:
                proxy.connected = False
                for unsubscribe in proxy.unsubscribers:
                    try:
                        unsubscribe()
                    except Exception:  # pylint: disable=broad-except
                        pass
                proxy.unsubscribers.clear()
                for address, active_proxy in list(self.active.items()):
                    if active_proxy is proxy:
                        self.active.pop(address, None)
                        await self.emit({
                            "type": "connection",
                            "address": int_to_mac(address),
                            "connected": False,
                            "mtu": 0,
                            "error": "ESPHome proxy disconnected",
                        })
                try:
                    await client.disconnect(force=True)
                except Exception:  # pylint: disable=broad-except
                    pass
                proxy.client = None

            if not self.shutting_down:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15.0)

    def candidates(self, address: int) -> list[Proxy]:
        now = time.monotonic()

        def score(proxy: Proxy) -> tuple[int, int, int]:
            seen_at, rssi, _ = proxy.advertisements.get(address, (0.0, -127, 0))
            fresh = 1 if now - seen_at <= 30 else 0
            slot = 1 if proxy.free > 0 or proxy.limit == 0 else 0
            return fresh, slot, rssi

        return sorted(
            (proxy for proxy in self.proxies if proxy.connected and proxy.client),
            key=score,
            reverse=True,
        )

    async def connect_device(self, request: dict[str, Any]) -> dict[str, Any]:
        address = mac_to_int(request["address"])
        timeout = float(request.get("timeout", 10))
        requested_type = request.get("address_type")
        errors: list[str] = []
        candidates = self.candidates(address)
        if not candidates:
            raise RuntimeError("no connected ESPHome Bluetooth proxy is available")

        for proxy in candidates:
            assert proxy.client is not None
            seen = proxy.advertisements.get(address)
            address_type = int(requested_type if requested_type is not None else (seen[2] if seen else 0))
            state = {"connected": False, "mtu": 0, "error": 0}

            def on_connection(connected: bool, mtu: int, error: int) -> None:
                state.update(connected=connected, mtu=mtu, error=error)
                asyncio.create_task(self.emit({
                    "type": "connection",
                    "address": int_to_mac(address),
                    "proxy": proxy.name,
                    "connected": connected,
                    "mtu": mtu,
                    "error": error,
                }))
                if not connected:
                    self.active.pop(address, None)

            try:
                unsubscribe = await proxy.client.bluetooth_device_connect(
                    address,
                    on_connection,
                    timeout=timeout,
                    feature_flags=proxy.feature_flags,
                    has_cache=False,
                    address_type=address_type,
                )
                if not state["connected"]:
                    unsubscribe()
                    raise RuntimeError(f"connection rejected with GATT error {state['error']}")
                previous = self.connection_unsubscribers.pop(address, None)
                if previous:
                    previous()
                self.connection_unsubscribers[address] = unsubscribe
                self.active[address] = proxy
                return {
                    "proxy": proxy.name,
                    "mtu": state["mtu"],
                    "address_type": address_type,
                }
            except Exception as error:  # pylint: disable=broad-except
                errors.append(f"{proxy.name}: {error}")
                log(f"connect {int_to_mac(address)} through {proxy.name} failed: {error}")

        raise RuntimeError("; ".join(errors))

    def session(self, request: dict[str, Any]) -> tuple[int, Proxy, APIClient]:
        address = mac_to_int(request["address"])
        proxy = self.active.get(address)
        if not proxy or not proxy.connected or not proxy.client:
            raise RuntimeError(f"{int_to_mac(address)} is not connected through an ESPHome proxy")
        return address, proxy, proxy.client

    async def handle(self, request: dict[str, Any]) -> Any:
        action = request.get("action")
        if action == "status":
            return [proxy.summary() for proxy in self.proxies]
        if action == "connect":
            return await self.connect_device(request)

        address, proxy, client = self.session(request)
        if action == "disconnect":
            await client.bluetooth_device_disconnect(address, timeout=float(request.get("timeout", 5)))
            unsubscribe = self.connection_unsubscribers.pop(address, None)
            if unsubscribe:
                unsubscribe()
            self.active.pop(address, None)
            return True
        if action == "clear_cache":
            result = await client.bluetooth_device_clear_cache(address)
            return {"success": result.success, "error": result.error}
        if action == "services":
            result = await client.bluetooth_gatt_get_services(address)
            return [
                {
                    "uuid": service.uuid,
                    "handle": service.handle,
                    "characteristics": [
                        {
                            "uuid": characteristic.uuid,
                            "handle": characteristic.handle,
                            "properties": characteristic.properties,
                            "descriptors": [
                                {"uuid": descriptor.uuid, "handle": descriptor.handle}
                                for descriptor in characteristic.descriptors
                            ],
                        }
                        for characteristic in service.characteristics
                    ],
                }
                for service in result.services
            ]
        handle = int(request["handle"])
        if action == "read":
            data = await client.bluetooth_gatt_read(address, handle)
            return bytes(data).hex()
        if action == "read_descriptor":
            data = await client.bluetooth_gatt_read_descriptor(address, handle)
            return bytes(data).hex()
        if action == "write":
            await client.bluetooth_gatt_write(
                address,
                handle,
                bytes.fromhex(request.get("data", "")),
                response=bool(request.get("response", True)),
            )
            return True
        if action == "write_descriptor":
            await client.bluetooth_gatt_write_descriptor(
                address,
                handle,
                bytes.fromhex(request.get("data", "")),
            )
            return True
        if action == "subscribe":
            key = (address, handle)
            if key in self.notification_stops:
                return True

            def on_notification(notify_handle: int, data: bytearray) -> None:
                asyncio.create_task(self.emit({
                    "type": "notification",
                    "address": int_to_mac(address),
                    "handle": notify_handle,
                    "data": bytes(data).hex(),
                    "proxy": proxy.name,
                }))

            self.notification_stops[key] = await client.bluetooth_gatt_start_notify(
                address,
                handle,
                on_notification,
            )
            return True
        if action == "unsubscribe":
            stops = self.notification_stops.pop((address, handle), None)
            if stops:
                await stops[0]()
                stops[1]()
            return True
        raise ValueError(f"unsupported action: {action}")

    async def run_requests(self) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            request: dict[str, Any] | None = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                result = await self.handle(request)
                await self.emit({"id": request_id, "ok": True, "result": result})
            except Exception as error:  # pylint: disable=broad-except
                await self.emit({
                    "id": request.get("id") if request else None,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                })

    async def close(self) -> None:
        self.shutting_down = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


async def main() -> None:
    endpoints = [
        item.strip()
        for item in os.environ.get("TTLOCK_ESPHOME_PROXY_HOSTS", "").split(",")
        if item.strip()
    ]
    if not endpoints:
        raise SystemExit("TTLOCK_ESPHOME_PROXY_HOSTS is empty")
    bridge = Bridge(endpoints)
    await bridge.start()
    try:
        await bridge.run_requests()
    finally:
        await bridge.close()


if __name__ == "__main__":
    asyncio.run(main())
