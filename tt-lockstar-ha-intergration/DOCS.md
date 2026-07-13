## How to Use

1. **Install Add-on**: Install the add-on from your supervisor panel (building the Docker image might take a few minutes on slower hardware).
2. **Set up Bluetooth**: 
   - Connect a compatible Bluetooth USB dongle to your Home Assistant device (recommended for the best range and stability).
   - In the **Configuration** tab, set the `bluetooth_adapter` option to match your adapter (usually `hci0` or `hci1`).
3. **Configure MQTT**: Make sure you have an MQTT broker installed and configured in Home Assistant (such as Mosquitto broker).
4. **Wake up the lock**: Press any key on your lock's keypad so it lights up and starts broadcasting BLE signals.
5. **Open Web UI & Pair**: Open the Ingress Web UI from the sidebar or the add-on page, and click the bold **Scan for Locks** button in the setup assistant to find and pair your lock.

---

## Configuration Settings

You can customize the add-on behavior under the **Configuration** tab in the Home Assistant UI:

```yaml
bluetooth_adapter: "hci0" # The Bluetooth device ID to use (e.g. hci0, hci1, 0, or 1)
bluetooth_transport: "raw_hci" # Validated fallback; bluez bypasses Noble for supervised experiments
ignore_crc: false # Set to true to ignore bad CRC checksums from older TTLock models
debug_communication: false # Set to true to log detailed raw BLE traffic for debugging
debug_mqtt: false # Set to true to log MQTT discovery and state messages
```

---

## Known Issues

- **Low BLE Signal**: Low BLE signals can lead to failed pairing attempts or missing/corrupted log syncs. Keep your Home Assistant Bluetooth dongle as close to the lock as possible.
- **Keypad Awake requirement**: The lock is offline and enters deep sleep when idle. It *must* be awake (keypad lit up) when attempting pairing, scans, or initial settings updates.
- **G2 gateway is separate**: Updating or continuing to use a TTLock G2 gateway is fine, but this local add-on does not communicate through the G2. It requires a Bluetooth adapter directly available to the Home Assistant host.
- **Transport choice**: `raw_hci` is the default because it completed the supervised alpha.13 lock/unlock test. `bluez` is the native BlueZ D-Bus experiment and bypasses Noble. `dbus` retains the older Noble-backed D-Bus implementation for comparison.
- **Adapter contention**: Raw HCI needs direct adapter ownership. Other software using the same adapter can interfere with commands; dedicate an adapter to this add-on when possible.
- **Sequential raw-HCI commands**: A supervised alpha.16 unlock succeeded, but the immediate relock could not reconnect until this add-on was restarted. Do not rely on back-to-back commands or unattended recovery yet.
- **Alpha.19 HCI cancellation experiment**: A retry now waits for Noble's pending connection slot to drain; if it remains stale, the command fails closed without a second connection attempt. Keep a manual fallback until repeated supervised timing and sequential-command tests pass.
- **Do not pair-reset casually**: Pairing/reset operations can change local lock ownership data. Test with lock/unlock and status reads first, and keep the TTLock app/G2 path available until the local setup is proven stable.
