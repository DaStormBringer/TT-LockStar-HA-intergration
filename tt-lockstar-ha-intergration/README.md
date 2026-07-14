# Home Assistant Add-on: TT-LockStar-HA-intergration

> [!CAUTION]
> **VERY EXPERIMENTAL — NOT PRODUCTION READY.** This add-on controls a physical door lock and has only limited single-device hardware validation. Use it only while physically present and retain a working mechanical key, keypad, or other manual entry method.

This add-on provides local Bluetooth control of compatible TTLock locks. It combines PiexlPuck's newer Home Assistant packaging and interface with selected RK392 reliability changes and TTLock SDK v0.3.34.

Home Assistant slug: `tt-lockstar-ha-intergration`. This is a new add-on identity and does not automatically inherit data from installations using the upstream `ttlock-hass-integration` slug.

Read the repository [merge and validation notes](../MERGE_NOTES.md) before installation.

Current version: `0.1.0-alpha.62`. The project uses Semantic Versioning and will remain in prerelease status until supervised lock-hardware testing is complete.

Current development prioritizes discovery, evidence-backed state, reliable lock/unlock, settings, PINs, and cards. Biometric fingerprint enrollment and management are unvalidated and intentionally last in the implementation and hardware-test order.

## Critical limitations

- Requires either a Bluetooth HCI adapter directly available to the Home Assistant Linux host or an explicitly configured local ESPHome Bluetooth Proxy.
- Does not communicate through a TTLock G2 gateway.
- ESPHome Bluetooth Proxy support has completed physically confirmed lock and unlock operations, but repeated lock/unlock reliability is not established.
- ESPHome proxy support currently accepts native API endpoints without an API password or Noise encryption key; keep them on a trusted local network.
- The default `home_assistant` advertisement source shares Home Assistant's Bluetooth WebSocket feed instead of claiming ESPHome's single advertisement subscription. The legacy `direct` source is diagnostic-only and can displace Home Assistant's proxy stream.
- When Home Assistant omits the BLE address type, the add-on leaves it unknown for the selected ESPHome proxy to resolve instead of guessing from the MAC prefix. ESPHome discovery is passive until an explicit read, preparation, or command requests GATT.
- The add-on explicitly requests active scan mode; proxies must support scanner state/mode control, active connections, and remote GATT caching.
- May contend with the TTLock app or G2 gateway when multiple systems contact the lock.
- Magnetic door-contact state is not deadbolt position. The lock entity stays unknown when the newest operation does not explicitly confirm the bolt.
- The diagnostic `Advertised Lock State` sensor is passive and experimental. The tested M302 returned `IDLE_NO_UNLOCK_SIGNAL` in both manually verified physical positions, so it must not be used to infer bolt position or authorize an automation.
- Must not be used as the only means of entering or securing the property.
- Must not be connected to unattended auto-unlock automations during experimental testing.

Do not reset or unpair an existing production lock unless its current pairing data and a recovery procedure are available. Resetting may disrupt the existing TTLock app or gateway relationship.

## Requirements

- Home Assistant OS or supervised Home Assistant on Linux
- Direct BlueZ-compatible Bluetooth adapter, normally `hci0` or `hci1`, or an ESPHome proxy supporting active connections and remote GATT caching
- MQTT broker for Home Assistant discovery, reporting, and control
- Manual entry fallback during all testing

The merged `amd64` Alpine image builds successfully. The declared `aarch64` target still requires a native build and hardware validation.

## Hardware validation

### Tested compatibility scope

Hardware compatibility is claimed only for the tested physical **M302** lock running firmware **6.4.43.24052101**. That value was returned by this physical lock on 2026-07-13 through the dedicated read-only `COMM_READ_DEVICE_INFO` / `FIRMWARE_REVISION` request using the Craft Everything Presence Lite proxy. This README does not claim compatibility with any other M302 firmware or any other lock model.

Detailed per-release changes and supervised hardware-test results are maintained in [UPDATE_NOTES.md](UPDATE_NOTES.md). The shorter [CHANGELOG.md](CHANGELOG.md) remains the release-oriented summary.

## Features

- Dedicated read-only firmware-revision request using `COMM_READ_DEVICE_INFO` / `FIRMWARE_REVISION`
- Read-only hardware-feature discovery with persisted capability metadata for reliable settings, PIN, and card routing after restarts
- Capability-discoverable WebSocket command API for the pinned SDK's supported high-level operations; see [API_COMMANDS.md](API_COMMANDS.md)
- Ingress interface for discovery and management
- Multiple-lock support
- Lock and unlock
- Bounded read-only prepared connections that wait up to 60 seconds for a sleeping lock, then automatically expire after 5 through 30 seconds
- Home Assistant MQTT discovery for a `Prewarm M302 Connection` button that starts one 15-second read-only lease; HA can press it from a local identity/dwell automation, and it never locks, unlocks, or authorizes a later actuator command
- Auto-lock settings up to 300 seconds
- Lock sound management
- PIN, IC card, and fingerprint management
- Cached credentials and operation logs with manual refresh
- Optional proactive operation-log fetching can update state after explicit manual lock/unlock events. It increases BLE traffic, and some firmware does not record auto-lock events, so it is disabled by default.
- Separate MQTT door binary sensor derived from magnetic contact open/closed records.
- Separate MQTT diagnostic sensor for the raw passive advertisement state, including observation time and `isUnlock`/`hasEvents` attributes; it never changes the confirmed lock entity.
- Process-local history of up to 50 unique advertisement payload signatures, with normalized raw manufacturer and service-data bytes available through read-only `lock.status.get` for supervised reverse-engineering comparisons.
- Lock clock read and synchronization controls
- MQTT discovery for lock state, battery, signal strength, and lock time
- BLE connection serialization and bounded connection recovery; physical lock and unlock payloads are executed exactly once per confirmed request and are never automatically retried
- Process-local ESPHome GATT service/MTU caching with automatic uncached recovery; the alpha.48 cached path completed a physically confirmed unlock, although its single timing sample did not improve on alpha.47

The preparation button is safe to call from an approach or presence automation because it only establishes and verifies a temporary BLE command channel. Keep every lock or unlock action in a separate automation or manual flow with its own authorization and safety checks. Repeated preparation can increase lock battery use and can contend with the TTLock app or G2 gateway, so trigger it only on a meaningful approach transition and allow the 15-second lease to expire.

## Recommended first test

1. Keep the TTLock app/G2 path and a manual entry method available.
2. Install without resetting or pairing the production lock.
3. Confirm the direct Bluetooth adapter is visible to Home Assistant.
4. Import known-good existing lock data if a safe source is available.
5. Disable automatic operation-log fetching initially.
6. Run the read-only firmware request and confirm that a `firmware` response is received before testing an actuator command.
7. Test status, lock, and unlock while physically at the open door.
8. Confirm the keypad, mechanical entry, TTLock app, and G2 still function.
9. Observe reliability before enabling any automation.

### Read-only firmware request

Send `{"type":"firmware","data":{"address":"DC:47:11:85:94:2F"}}` to the add-on's `/api` WebSocket before waking the keypad. The request reserves the lock from background metadata refreshes and waits up to 60 seconds for a fresh advertisement. A successful response uses type `firmware` and includes `command: "COMM_READ_DEVICE_INFO"`, `infoType: "FIRMWARE_REVISION"`, the returned `firmwareRevision`, and `readOnly: true`. The add-on disconnects after the response. This route does not lock, unlock, change settings, synchronize time, or perform a firmware update.

## Security and dependency notice

Pairing material, administrative data, credentials, and operation logs are stored in add-on data and may be included in Home Assistant backups. Protect the host and its backups, and do not expose the add-on service directly to the internet.

The selectable legacy native raw-HCI fallback retains its old dependency chain. The validated image reports 7 moderate, 7 high, and 2 critical audit findings. The high and critical findings are inherited through the old Noble socket build/install toolchain (`node-gyp`, `node-pre-gyp`, `request`, `tar`, and related packages); there is no non-breaking automatic upgrade for this pinned runtime. The add-on must remain local-only, and `npm audit fix --force` must not be used without a complete rebuild and supervised hardware regression test.

## Attribution and license

Original creator: Emanuel Posescu (`kind3r`). This merged version also incorporates work from PiexlPuck and RK392. The project remains licensed under the GNU General Public License v3.0; see [LICENSE.md](LICENSE.md).
