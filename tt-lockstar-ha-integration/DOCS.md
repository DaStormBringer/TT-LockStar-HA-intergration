## How to Use

1. **Install Add-on**: Install the add-on from your supervisor panel (building the Docker image might take a few minutes on slower hardware).
2. **Set up Bluetooth**: 
   - Connect a compatible Bluetooth USB dongle to your Home Assistant device (recommended for the best range and stability).
   - In the **Configuration** tab, set the `bluetooth_adapter` option to match your adapter (usually `hci0` or `hci1`).
3. **Configure MQTT**: Make sure you have an MQTT broker installed and configured in Home Assistant (such as Mosquitto broker).
4. **Wake up the lock**: Press any key on your lock's keypad so it lights up and starts broadcasting BLE signals.
5. **Open Web UI & Pair**: Open the Ingress Web UI from the sidebar or the add-on page, and click the bold **Scan for Locks** button in the setup assistant to find and pair your lock.

After MQTT discovery completes, Home Assistant also exposes a **Prewarm M302 Connection** button. It opens and verifies a read-only BLE connection for at most 15 seconds so an approach automation can absorb lock wake-up latency. The button does not move the bolt or authorize a later lock/unlock request. Trigger it only when HA's local identity/dwell logic detects meaningful approach to limit battery use and contention with the TTLock app or G2 gateway.

---

## Configuration Settings

You can customize the add-on behavior under the **Configuration** tab in the Home Assistant UI:

```yaml
bluetooth_adapter: "hci0" # The Bluetooth device ID to use (e.g. hci0, hci1, 0, or 1)
bluetooth_transport: "raw_hci" # Validated fallback; bluez bypasses Noble for supervised experiments
esphome_proxy_hosts: "" # For esphome_proxy: comma-separated local native API endpoints
esphome_advertisement_source: "home_assistant" # Share HA's Bluetooth feed; direct is legacy diagnostic mode
ignore_crc: false # Set to true to ignore bad CRC checksums from older TTLock models
debug_communication: false # Set to true to log detailed raw BLE traffic for debugging
debug_mqtt: false # Set to true to log MQTT discovery and state messages
```

---

## Known Issues

- **Low BLE Signal**: Low BLE signals can lead to failed pairing attempts or missing/corrupted log syncs. Keep your Home Assistant Bluetooth dongle as close to the lock as possible.
- **Wake behavior**: Pairing and initial discovery may still require touching the keypad. The tested M302 has accepted commands from its sleeping advertisement through the dedicated Craft proxy, but weak signal or a missed advertisement may still require a keypad touch. Alpha.48 does not keep the lock connected or awake.
- **G2 gateway is separate**: Updating or continuing to use a TTLock G2 gateway is fine, but this local add-on does not communicate through the G2. It requires a Bluetooth adapter directly available to the Home Assistant host.
- **Transport choice**: `raw_hci` is the default because it completed the supervised alpha.13 lock/unlock test. `bluez` is the native BlueZ D-Bus experiment and bypasses Noble. `dbus` retains the older Noble-backed D-Bus implementation for comparison.
- **ESPHome proxy transport**: Select `esphome_proxy` and set `esphome_proxy_hosts` to one or more local endpoints such as `192.168.1.30:6053,192.168.1.55:6053`. The bridge requests active scanning and automatically chooses the proxy with a recent lock advertisement, available connection capacity, and the strongest signal. This stays local and does not use TTLock Cloud.
- **Shared Home Assistant advertisement feed**: The default `home_assistant` source subscribes to Home Assistant's supported Bluetooth WebSocket stream. Home Assistant remains ESPHome's advertisement subscriber while TT LockStar uses separate native API clients for active scan mode and GATT. Use the legacy `direct` source only for bounded diagnostics because it can displace Home Assistant's proxy stream.
- **ESPHome proxy features**: Each configured endpoint must support scanner state/mode control, active connections, and remote GATT caching.
- **ESPHome GATT cache**: Alpha.48 keeps a successfully discovered service table and MTU in the running bridge process to shorten later sessions. A cached failure is invalidated before one uncached retry. Authentication and command-response checks are never cached.
- **ESPHome API authentication**: Alpha.32 supports proxies with no native API password or Noise encryption key. Keep the endpoints on a trusted local network. Credential support is required before using encrypted ESPHome API configurations.
- **Adapter contention**: Raw HCI needs direct adapter ownership. Other software using the same adapter can interfere with commands; dedicate an adapter to this add-on when possible.
- **Sequential raw-HCI commands**: A supervised alpha.16 unlock succeeded, but the immediate relock could not reconnect until this add-on was restarted. Do not rely on back-to-back commands or unattended recovery yet.
- **Alpha.19 HCI cancellation experiment**: A retry now waits for Noble's pending connection slot to drain; if it remains stale, the command fails closed without a second connection attempt. Keep a manual fallback until repeated supervised timing and sequential-command tests pass.
- **Do not pair-reset casually**: Pairing/reset operations can change local lock ownership data. Test with lock/unlock and status reads first, and keep the TTLock app/G2 path available until the local setup is proven stable.
