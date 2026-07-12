# Home Assistant Add-on: TT-LockStar-HA-intergration

> [!CAUTION]
> **VERY EXPERIMENTAL — NOT PRODUCTION READY.** This add-on controls a physical door lock and has not yet been validated with production lock hardware. Use it only while physically present and retain a working mechanical key, keypad, or other manual entry method.

This add-on provides local Bluetooth control of compatible TTLock locks. It combines PiexlPuck's newer Home Assistant packaging and interface with selected RK392 reliability changes and TTLock SDK v0.3.34.

Home Assistant slug: `tt-lockstar-ha-intergration`. This is a new add-on identity and does not automatically inherit data from installations using the upstream `ttlock-hass-integration` slug.

Read the repository [merge and validation notes](../MERGE_NOTES.md) before installation.

Current version: `0.1.0-alpha.14`. The project uses Semantic Versioning and will remain in prerelease status until supervised lock-hardware testing is complete.

## Critical limitations

- Requires a Bluetooth HCI adapter directly available to the Home Assistant Linux host.
- Does not communicate through a TTLock G2 gateway.
- Does not use Home Assistant Bluetooth proxies.
- May contend with the TTLock app or G2 gateway when multiple systems contact the lock.
- Magnetic door-contact state is not deadbolt position. The lock entity stays unknown when the newest operation does not explicitly confirm the bolt.
- Must not be used as the only means of entering or securing the property.
- Must not be connected to unattended auto-unlock automations during experimental testing.

Do not reset or unpair an existing production lock unless its current pairing data and a recovery procedure are available. Resetting may disrupt the existing TTLock app or gateway relationship.

## Requirements

- Home Assistant OS or supervised Home Assistant on Linux
- Direct BlueZ-compatible Bluetooth adapter, normally `hci0` or `hci1`
- MQTT broker for Home Assistant discovery, reporting, and control
- Manual entry fallback during all testing

The merged `amd64` Alpine image builds successfully. The declared `aarch64` target still requires a native build and hardware validation.

## Hardware validation

On 2026-07-12, `0.1.0-alpha.13` completed one supervised physical unlock and lock cycle on an M302 lock through a direct `hci0` adapter. Both commands returned success on their first command-only attempt, the deadbolt movement was confirmed at the door, and Home Assistant changed from `unlocked` to `locked` accordingly. Signal during the test was approximately -83 to -79 dB.

This is a single-device experimental result, not production qualification. Noble still emitted an intermittent `unknown peripheral null connected` warning during the successful lock attempt, so unattended control and auto-unlock remain out of scope.

Alpha.14 replaces the former `@abandonware/noble` raw-HCI runtime with `@stoprocent/noble` 2.5.5 using BlueZ over host D-Bus. This preserves the configured adapter but is a new transport path; it has not inherited alpha.13's hardware-validation result and must be tested again at the open door.

## Features

- Ingress interface for discovery and management
- Multiple-lock support
- Lock and unlock
- Auto-lock settings up to 300 seconds
- Lock sound management
- PIN, IC card, and fingerprint management
- Cached credentials and operation logs with manual refresh
- Optional proactive operation-log fetching can update state after explicit manual lock/unlock events. It increases BLE traffic, and some firmware does not record auto-lock events, so it is disabled by default.
- Separate MQTT door binary sensor derived from magnetic contact open/closed records.
- Lock clock read and synchronization controls
- MQTT discovery for lock state, battery, signal strength, and lock time
- BLE connection serialization and retry handling

## Recommended first test

1. Keep the TTLock app/G2 path and a manual entry method available.
2. Install without resetting or pairing the production lock.
3. Confirm the direct Bluetooth adapter is visible to Home Assistant.
4. Import known-good existing lock data if a safe source is available.
5. Disable automatic operation-log fetching initially.
6. Test status, lock, and unlock while physically at the open door.
7. Confirm the keypad, mechanical entry, TTLock app, and G2 still function.
8. Observe reliability before enabling any automation.

## Security and dependency notice

Pairing material, administrative data, credentials, and operation logs are stored in add-on data and may be included in Home Assistant backups. Protect the host and its backups, and do not expose the add-on service directly to the internet.

Alpha.14 changes the native Bluetooth dependency chain. Review the current build's audit output rather than relying on the alpha.13 advisory count, and do not apply `npm audit fix --force` without complete rebuild and regression testing.

The validated alpha.14 image reports four moderate advisories and no high or critical advisories with `npm audit --omit=dev --omit=optional`. All four are the same transitive `xml2js` advisory propagated through `dbus-next`, Noble, and the SDK; npm reports no compatible automatic fix. Optional native HCI/socket packages are not installed.

## Attribution and license

Original creator: Emanuel Posescu (`kind3r`). This merged version also incorporates work from PiexlPuck and RK392. The project remains licensed under the GNU General Public License v3.0; see [LICENSE.md](LICENSE.md).
