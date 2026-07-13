# Home Assistant Add-on: TT-LockStar-HA-intergration

> [!CAUTION]
> **VERY EXPERIMENTAL — NOT PRODUCTION READY.** This add-on controls a physical door lock and has not yet been validated with production lock hardware. Use it only while physically present and retain a working mechanical key, keypad, or other manual entry method.

This add-on provides local Bluetooth control of compatible TTLock locks. It combines PiexlPuck's newer Home Assistant packaging and interface with selected RK392 reliability changes and TTLock SDK v0.3.34.

Home Assistant slug: `tt-lockstar-ha-intergration`. This is a new add-on identity and does not automatically inherit data from installations using the upstream `ttlock-hass-integration` slug.

Read the repository [merge and validation notes](../MERGE_NOTES.md) before installation.

Current version: `0.1.0-alpha.24`. The project uses Semantic Versioning and will remain in prerelease status until supervised lock-hardware testing is complete.

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

Alpha.14 replaced the former `@abandonware/noble` raw-HCI runtime with `@stoprocent/noble` 2.5.5 using BlueZ over host D-Bus. Two supervised unlock tests failed: the lock was visible at approximately -77 dB, but the BLE session disconnected during generic characteristic reads or while waiting for the `checkUserTime` response. The second test used an open door, extended deadbolt, and awake keypad, so strike resistance was excluded.

Alpha.15 invalidates stale D-Bus `Connected` and `ServicesResolved` cache entries after a remote disconnect and gives command-only connections a shorter setup path that discovers the TTLock service without rereading cached generic device information. The image must still pass another supervised open-door hardware test before this change can be considered validated.

Alpha.24 retains D-Bus as an explicit experimental option, waits up to 15 seconds for a keypad wake advertisement, and refreshes only the target's unpaired stale BlueZ cache when no advertisement arrives. It refuses to remove host-paired devices. New installations still default to the legacy raw-HCI transport that completed the alpha.13 supervised physical test. Neither path is ready for unattended lock control.

The installed alpha.16 image completed a supervised open-door physical cycle. Unlock returned `true` on the first manager attempt, the bolt retracted, and Home Assistant changed to `unlocked`. An immediate relock then failed: attempt 1 hit the 55-second hard timeout and attempts 2–3 could not connect, leaving the bolt physically retracted. Restarting only this add-on cleared Noble's stale raw-HCI session; the following lock returned `true` on its first manager attempt, extended the bolt, and changed Home Assistant to `locked`. Raw HCI can operate the lock, but sequential command recovery remains a blocking reliability defect.

Alpha.17 replaced the inherited 40–55 second command connection waits with a bounded command-only policy. In supervised testing, one lock command completed physically in about 18 seconds. The following unlock exposed a stale optimistic state but did not move the bolt: the first connection reached the 12-second outer timeout, the retry could not connect, and the user confirmed the door remained locked. The timeout bounded the failure, but the expired setup continued in the background and contaminated the retry.

Alpha.18 explicitly cancelled and reset an expired connection before retrying, and limited command discovery to TTLock service `1910`. In supervised testing, an unlock still failed safely: the first attempt reached its 12-second timeout, the retry collided with Noble's still-pending HCI cancellation and reported `unknown peripheral null connected`, and the user confirmed the physical deadbolt remained locked.

Alpha.19 waits for Noble's pending connection slot to drain before retrying. If cancellation does not drain within its bounded cleanup window, it fails closed without issuing the known-stale retry. Elapsed-time logging is included for the next supervised test.

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

Alpha.16 intentionally restores the legacy native raw-HCI dependency chain as a selectable fallback. The validated image reports 7 moderate, 7 high, and 2 critical audit findings. The high and critical findings are inherited through the old Noble socket build/install toolchain (`node-gyp`, `node-pre-gyp`, `request`, `tar`, and related packages); there is no non-breaking automatic upgrade for this pinned runtime. The add-on must remain local-only, and `npm audit fix --force` must not be used without a complete rebuild and supervised hardware regression test.

## Attribution and license

Original creator: Emanuel Posescu (`kind3r`). This merged version also incorporates work from PiexlPuck and RK392. The project remains licensed under the GNU General Public License v3.0; see [LICENSE.md](LICENSE.md).
