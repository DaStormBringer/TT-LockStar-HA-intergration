# TT-LockStar-HA-intergration

> [!CAUTION]
> **VERY EXPERIMENTAL.** This software can operate a physical door lock. Hardware validation is incomplete, and passing automated tests does not establish safe production operation. It must not be treated as the only means of entering or securing a property. Test only while physically present with a working mechanical key, keypad, or other manual fallback.

This repository merges the newer Home Assistant packaging and interface work from `PiexlPuck/hass-addons` with compatible reliability changes from `RK392/hass-addons` and the RK392 TTLock SDK v0.3.34.

The public project and repository name is `TT-LockStar-HA-intergration`. Its Home Assistant add-on slug is `tt-lockstar-ha-intergration`.

The slug was changed before the first release. Home Assistant treats a changed slug as a different add-on, so installations made under the former `ttlock-hass-integration` slug will not automatically inherit add-on data or configuration.

Read [MERGE_NOTES.md](MERGE_NOTES.md) before building, installing, pairing, or operating a lock.

Detailed release and supervised hardware-test history is in [UPDATE_NOTES.md](tt-lockstar-ha-intergration/UPDATE_NOTES.md).

## Current status

- Add-on version: `0.1.0-alpha.48`
- Home Assistant stage: `experimental`
- Development branch: `main`
- Target: Home Assistant on Linux
- Verified image: Home Assistant Alpine Linux, `amd64`
- Frontend production build: successful before the final package rename; renamed packaged assets verified in the final Docker image
- Backend JavaScript syntax checks: successful
- SDK v0.3.34 compile and method inspection: successful
- Real Bluetooth adapter and lock test: discovery, battery, time, magnetic contact, operation-log reads, unlock, and lock have worked with raw HCI. Native BlueZ has one physically verified round trip without an add-on restart. ESPHome through the dedicated Craft proxy has also completed a sleeping-keypad alpha.47 round trip: 7.574-second unlock and 5.569-second lock, both physically confirmed. These are promising single-device results, not unattended-use qualification.
- Production readiness: **not ready**

Compatibility is claimed only for the user's **M302** lock running firmware **6.4.43.24052101**. That value was read from this physical lock on 2026-07-13 through the dedicated read-only `COMM_READ_DEVICE_INFO` request using the Craft ESPHome proxy. No other lock model or M302 firmware is claimed as tested.

The source repository may be stored or edited on Windows, but the deployable add-on image is Linux-native and was built with Docker Desktop's Linux engine.

## Connection architecture

This add-on communicates locally with a TTLock-compatible lock using a selectable Bluetooth transport. `raw_hci` is the default because it passed the supervised physical test; `dbus` uses maintained `@stoprocent/noble` 2.5.5; `bluez` bypasses Noble with a native BlueZ D-Bus adapter; and `esphome_proxy` uses the native API of one or more existing ESPHome Bluetooth proxies. All non-default paths remain experimental.

- A direct USB/onboard Bluetooth adapter is required for `raw_hci`, `dbus`, and `bluez`; `esphome_proxy` instead requires a local ESPHome device with active Bluetooth connections and remote GATT caching enabled.
- The adapter is selected with `bluetooth_adapter`, normally `hci0` or `hci1`.
- The transport is selected with `bluetooth_transport`: `raw_hci` by default, Noble-backed `dbus`, native `bluez`, or local `esphome_proxy`.
- `esphome_proxy_hosts` is a comma-separated list of native API endpoints such as `192.168.1.30:6053,192.168.1.55:6053`. No TTLock Cloud or G2 gateway is used by this transport.
- ESPHome proxy support currently accepts native API endpoints without an API password or Noise encryption key. Keep those endpoints on a trusted local network; encrypted proxy credentials are not implemented yet.
- With `esphome_advertisement_source: home_assistant` (the default), Home Assistant retains the ESPHome advertisement subscription and TT LockStar consumes the supported `bluetooth/subscribe_advertisements` WebSocket feed. The add-on's direct ESPHome clients remain connection-only for active scan mode and GATT. The legacy `direct` source is retained only for bounded diagnostics and can displace Home Assistant's proxy stream.
- The add-on explicitly requests active scanning whenever it connects to a proxy. The proxy must expose scanner state/mode control in addition to active connections and remote GATT caching.
- A TTLock G2 gateway is not a transport for this add-on and remains a separate TTLock app/cloud path.
- Simultaneous access from the G2, TTLock app, and this add-on may cause Bluetooth contention or failed operations.

Do not reset, unpair, or initialize an existing production lock until its current ownership/pairing data and recovery path are understood. A reset could disrupt the existing TTLock app or gateway relationship.

## Features

- Dedicated read-only firmware-revision request using `COMM_READ_DEVICE_INFO` / `FIRMWARE_REVISION`
- Capability-discoverable WebSocket command API covering the pinned SDK's supported high-level operations
- Local lock and unlock commands
- Multiple-lock discovery and management
- PIN, IC card, and fingerprint management
- Lock sound and auto-lock settings up to 300 seconds
- Cached credentials and operation logs with manual refresh
- Optional automatic operation-log fetching
- Lock clock read and synchronization controls
- Home Assistant MQTT discovery for lock state, battery, signal level, and lock time
- BLE connection serialization and retry handling
- Home Assistant Ingress interface

The generic command API, its exact-confirmation rules, and the intentionally excluded low-level SDK internals are documented in [API_COMMANDS.md](tt-lockstar-ha-intergration/API_COMMANDS.md).

## Requirements

- Home Assistant OS or a supervised Linux installation capable of running local add-ons
- Direct Bluetooth adapter visible to the Home Assistant host, or a local ESPHome proxy configured for active connections and remote GATT caching
- Host networking and Bluetooth permissions supplied by the add-on configuration; host D-Bus is also required for the experimental D-Bus transport
- MQTT broker for Home Assistant discovery, state reporting, and control
- A manual means of entry during every test

Only the `amd64` image has been built and inspected during this merge. The manifest also declares `aarch64`, but that architecture still needs a native image build and hardware test.

## Versioning

This project uses Semantic Versioning:

- `0.1.0-alpha.N`: active development; incomplete and potentially breaking
- `0.1.0-beta.N`: feature-complete candidate undergoing supervised hardware testing
- `0.1.0-rc.N`: release candidate with no known blocking defects
- `0.1.0`: first experimental release considered usable for careful manual operation
- `0.MINOR.PATCH`: pre-1.0 development; minor releases may still contain breaking changes
- `1.0.0`: reserved for a documented, migration-aware release with sustained hardware validation

Git release tags use the matching `vVERSION` form, beginning with `v0.1.0-alpha.1`.

## Conservative first-test procedure

1. Keep the existing TTLock app/G2 path and a manual entry method available.
2. Install the add-on without resetting or pairing the production lock.
3. Confirm the intended local Bluetooth adapter is visible to Home Assistant.
4. Import known-good existing lock data if a safe source is available.
5. Leave automatic operation-log fetching disabled initially.
6. Test status reads while physically at the door.
7. Test one lock and one unlock command with the door open.
8. Verify the TTLock app, G2 gateway, keypad, and mechanical entry method still work.
9. Observe reliability before enabling automations.

Do not connect this experimental add-on to unattended auto-unlock, facial-recognition, presence, or geofence automations.

## Build

The validated local `amd64` build command is:

```sh
docker build \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest \
  --tag tt-lockstar-ha-intergration:0.1.0-alpha.48 \
  ./tt-lockstar-ha-intergration
```

Building an image does not validate Bluetooth behavior. Final testing must occur on the Home Assistant Linux host with its real adapter and lock.

## Known risks and limitations

- The project is unofficial and is not affiliated with TTLock or Home Assistant.
- There is no upstream automated test suite.
- Lock pairing material, administrative data, credentials, and operation logs are stored in add-on data and may be included in backups. Protect both.
- Do not expose the add-on API or Ingress service directly to the internet.
- Native Bluetooth behavior depends on adapter hardware, driver support, signal quality, D-Bus, and host networking.
- Raw HCI remains the default and the native `bluez` option remains available. Native BlueZ removes only the target's host-unpaired cache after disconnect so each wake can provide a fresh connection object; host-paired devices are preserved. It also keeps discovery active for command connections and shortens only the safely bounded native retry path. These latency changes still require supervised physical validation.
- Alpha.48 reuses an ESPHome GATT service/MTU cache after the first successful discovery and automatically retries uncached after a cached failure. The optimization does not bypass TTLock authentication or response checks and remains pending supervised timing validation.
- The image installs both transports, compiles the raw-HCI native binding, explicitly builds the pinned TTLock SDK commit, and then runs the fail-closed patch step.
- `npm audit --omit=dev` reports 7 moderate, 7 high, and 2 critical findings. Most high/critical findings are inherited through the legacy raw-HCI build/install dependency chain. There is no safe automatic upgrade for the pinned runtime; keep the add-on local-only and do not use `npm audit fix --force`.
- Generated frontend assets are committed because the Home Assistant add-on image copies the prebuilt interface.

## Project lineage

- Original add-on and SDK: Emanuel Posescu (`kind3r`)
- Home Assistant packaging and interface base: `PiexlPuck/hass-addons`
- Reliability changes and SDK v0.3.34: `RK392/hass-addons` and `RK392/ttlock-sdk-js`
- Local merge and Docker validation: Chad Shipman

The upstream histories are preserved in the merge commit. See [MERGE_NOTES.md](MERGE_NOTES.md) for the selected changes and validation record.

## License

This project remains licensed under the GNU General Public License v3.0. The original license and author attribution are retained in [LICENSE.md](tt-lockstar-ha-intergration/LICENSE.md). Modified versions and redistributed builds must continue to comply with the GPL.
