# Home Assistant Add-on: TT-LockStar-HA-intergration

> [!CAUTION]
> **VERY EXPERIMENTAL — NOT PRODUCTION READY.** This add-on controls a physical door lock and has not yet been validated with production lock hardware. Use it only while physically present and retain a working mechanical key, keypad, or other manual entry method.

This add-on provides local Bluetooth control of compatible TTLock locks. It combines PiexlPuck's newer Home Assistant packaging and interface with selected RK392 reliability changes and TTLock SDK v0.3.34.

Home Assistant slug: `tt-lockstar-ha-intergration`. This is a new add-on identity and does not automatically inherit data from installations using the upstream `ttlock-hass-integration` slug.

Read the repository [merge and validation notes](../MERGE_NOTES.md) before installation.

Current version: `0.1.0-alpha.42`. The project uses Semantic Versioning and will remain in prerelease status until supervised lock-hardware testing is complete.

## Critical limitations

- Requires either a Bluetooth HCI adapter directly available to the Home Assistant Linux host or an explicitly configured local ESPHome Bluetooth Proxy.
- Does not communicate through a TTLock G2 gateway.
- ESPHome Bluetooth Proxy support has completed physically confirmed lock and unlock operations, but repeated lock/unlock reliability is not established.
- Alpha.32 supports only ESPHome native API endpoints without an API password or Noise encryption key; keep them on a trusted local network.
- ESPHome currently allows one Bluetooth proxy API subscriber at a time. Configured proxy endpoints are dedicated to TT LockStar while this add-on runs, so Home Assistant Core cannot simultaneously receive Bluetooth advertisements from those same proxies.
- Alpha.32 explicitly requests active scan mode; proxies must support scanner state/mode control, active connections, and remote GATT caching.
- May contend with the TTLock app or G2 gateway when multiple systems contact the lock.
- Magnetic door-contact state is not deadbolt position. The lock entity stays unknown when the newest operation does not explicitly confirm the bolt.
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

Hardware compatibility is claimed only for the user's **M302** lock and the firmware currently installed on that device. The current SDK metadata reports that firmware value as `unknown`, so this README does not claim compatibility with any other M302 firmware or any other lock model. Replace `unknown` with the exact reported value after a successful full-metadata read; do not broaden this statement from a protocol-only or simulated test.

On 2026-07-12, `0.1.0-alpha.13` completed one supervised physical unlock and lock cycle on an M302 lock through a direct `hci0` adapter. Both commands returned success on their first command-only attempt, the deadbolt movement was confirmed at the door, and Home Assistant changed from `unlocked` to `locked` accordingly. Signal during the test was approximately -83 to -79 dB.

This is a single-device experimental result, not production qualification. Noble still emitted an intermittent `unknown peripheral null connected` warning during the successful lock attempt, so unattended control and auto-unlock remain out of scope.

Alpha.14 replaced the former `@abandonware/noble` raw-HCI runtime with `@stoprocent/noble` 2.5.5 using BlueZ over host D-Bus. Two supervised unlock tests failed: the lock was visible at approximately -77 dB, but the BLE session disconnected during generic characteristic reads or while waiting for the `checkUserTime` response. The second test used an open door, extended deadbolt, and awake keypad, so strike resistance was excluded.

Alpha.15 invalidates stale D-Bus `Connected` and `ServicesResolved` cache entries after a remote disconnect and gives command-only connections a shorter setup path that discovers the TTLock service without rereading cached generic device information. The image must still pass another supervised open-door hardware test before this change can be considered validated.

Alpha.28 retained the native `bluez` option that bypasses Noble and implements discovery, connection, GATT enumeration, notifications, reads, and writes directly through BlueZ D-Bus. Native disconnect removes only the host-unpaired target cache so the next wake creates a fresh device object.

Alpha.29 records the first physically verified native BlueZ round trip on the front-door lock without restarting the add-on. Unlock returned its authenticated success response in 4.32 seconds and the user confirmed that the bolt retracted. The immediate lock's first connection timed out before the lock command was written; its bounded retry connected in 447 ms, returned the authenticated lock response in 9.17 seconds total, and the user confirmed that the bolt extended. The native process loaded no Noble runtime modules. New installations still default to legacy raw HCI, and one supervised cycle is not enough to authorize unattended or automatic lock control.

Alpha.30 targets the remaining command latency. Native BlueZ keeps discovery active while initiating a command connection, retries after 100 ms instead of 1.5 seconds, and bounds a failed command connection at 4.5 seconds instead of 6 seconds. It preserves authenticated command handling, the two-attempt limit, and every non-native transport policy. These timing changes require supervised physical validation before their performance or reliability is established.

Alpha.31 adds a fully local `esphome_proxy` transport. A small Python bridge uses the ESPHome native API for advertisements, proxy selection, active BLE connections, GATT enumeration, reads, writes, and notifications while the existing JavaScript SDK continues to own TTLock credentials, encryption, and commands. It does not use TTLock Cloud or the G2 gateway. This path must pass read-only discovery and supervised physical command testing before it is considered hardware validated.

Alpha.32 follows the first deployed read-only test, where an M302 keypad wake was not observed after the add-on reclaimed the proxy subscriptions. It explicitly requests active scanning on every proxy connection and documents that ESPHome's newest Bluetooth API subscriber owns the proxy stream. This remains a discovery fix awaiting the next live wake test; it is not a successful lock-operation claim.

Alpha.33 addresses the next deployed wake test: active scanning was requested successfully, but the paired M302 still did not reach the TTLock matcher. ESPHome advertisements from the exact stored paired-lock MAC are now accepted even when service UUID `1910` is absent; UUID filtering remains mandatory for unknown addresses. This is awaiting another live wake test and is not a lock-operation claim.

Alpha.34 follows a synchronized sole-subscriber capture. The deployed ESPHome firmware rejected a second Bluetooth subscriber, so the add-on was stopped for the bounded diagnostic. The Living Room proxy then received five M302 wake packets at approximately -81 to -79 dBm, while the Master Bedroom proxy delivered no packets. The packets arrived through ESPHome's raw-advertisement batch message and contained the paired MAC, UUID `1910`, M302 name, manufacturer data, and service data. Alpha.34 consumes that raw format and decodes it locally. No lock command was sent, and this remains awaiting a deployed metadata session.

After a supported integration handoff made the Living Room proxy the dedicated TT LockStar Bluetooth subscriber, alpha.34 completed a full read-only metadata session in 18.9 seconds and updated lock time through MQTT. Its first supervised unlock test then failed safely: both ESPHome connection attempts timed out before any unlock payload was written, and the user confirmed the deadbolt remained locked. Alpha.35 widens only the ESPHome connection window and allows its failed-connect cleanup to finish before a retry; it does not change command authentication or any direct-adapter timing.

Alpha.35 then completed the first physically confirmed ESPHome proxy unlock on this M302. It connected through the Living Room proxy and returned authenticated success in 2.67 seconds; the user confirmed the deadbolt retracted. Two supervised relock commands subsequently connected but lost the BLE session during the authenticated `checkUserTime` exchange, before either actuator payload was written; the user confirmed the bolt remained unlocked. Alpha.36 sends the three BLE fragments of each handshake as one ordered bridge transaction to reduce process/API round-trip latency while preserving 20 ms pacing and the full TTLock authentication exchange. It still requires supervised hardware validation.

Alpha.36 then completed a physically confirmed ESPHome proxy lock on its first attempt in 4.66 seconds. The authenticated response returned and the user confirmed the deadbolt extended. Three subsequent unlock tests failed safely: the immediate attempt could not establish another GATT session, and later attempts connected but disconnected during `checkUserTime`; no unlock actuator command was written and the user confirmed the bolt remained locked each time. The official TTLock Android flow uses administrator authentication for an administrator unlock, while the inherited JavaScript SDK always used the ordinary-user time check. Alpha.37 selects `CHECK_ADMIN` only when an imported administrator password is present and retains the existing time-window path for ordinary eKeys. This remains supervised-test-only.

Alpha.37 then completed a physically confirmed administrator-authenticated unlock through the Living Room ESPHome proxy on its first attempt in 3.60 seconds. The following relock still used the inherited ordinary-user `checkUserTime` path, disconnected before the actuator payload, and timed out on its bounded retry; the user confirmed the bolt remained unlocked. TTLock's V2 interface exposes a corresponding `lockByAdministrator` operation. Alpha.38 therefore selects `CHECK_ADMIN` for lock as well as unlock when administrator credentials are present, while retaining `CHECK_USER_TIME` for ordinary eKeys. The lock command payload and response validation are unchanged, and this remains supervised-test-only pending live validation.

Alpha.38 did not validate that administrator-lock assumption on this M302. Both bounded attempts connected through the Living Room ESPHome proxy, sent the administrator-check fragments, and disconnected while waiting for the response before any lock actuator payload was sent; the user confirmed the bolt remained unlocked. The official React Native wrapper exposes a generic `controlLock(LOCK, lockData)` boundary and leaves authorization selection inside TTLock's native SDK, while the pinned JavaScript SDK analysis documents administrator authentication for unlock but the user-time check for lock. Alpha.39 therefore reverts only lock to `CHECK_USER_TIME`; the physically validated administrator-unlock path remains unchanged. This is a compatibility rollback awaiting another supervised test, not a production-reliability claim.

Alpha.39 confirmed the rollback but did not complete a lock operation: both attempts connected through the Living Room proxy in under 1.4 seconds, then disconnected while waiting for the `CHECK_USER_TIME` response, and the user confirmed the bolt remained unlocked. A comparison lock from the TTLock phone app succeeded; the ESPHome advertisements changed from `newEvents: true` to `lockedStatus: true`, demonstrating that the lock actuator and passive proxy observation path were healthy. ESPHome write-without-response calls confirm local queueing rather than peripheral consumption, so alpha.40 increased only the inter-fragment drain interval from 20 ms to 100 ms.

Alpha.40 started successfully and its metadata session completed multipart commands with 100 ms pacing, but the supervised unlock failed safely: both bounded attempts connected and sent the two-fragment administrator check, then disconnected while waiting for its response; the user confirmed the bolt remained locked. The bridge was retaining aioesphomeapi's notification-subscription marker after the underlying BLE connection ended. Because ESPHome notification registration belongs to the current connection, a reconnect could falsely report that it was already subscribed and omit the new start-notify request. Alpha.41 removes the stale local callback on every observed disconnect and defensively before reconnecting, forcing each BLE session to establish its own notification path. The command authentication, payloads, response checks, 100 ms fragment pacing, and two-attempt fail-closed limit are unchanged. This fix remains awaiting supervised validation.

Alpha.41 then passed three consecutive supervised operations through the Living Room ESPHome proxy. Administrator unlock completed on attempt one in 6.815 seconds, the following user-time-authenticated lock completed on attempt one in 1.722 seconds, and the next administrator unlock completed on attempt one in 4.262 seconds. The user physically confirmed every bolt movement, and the bridge cleared the connection-scoped notification callback after each operation. A lock test without touching the keypad exposed a separate latency defect: attempt one started from a 9.987-second-old advertisement and spent 20 seconds timing out; attempt two used a 50 ms-old advertisement, connected in 8.363 seconds, sent the authenticated lock exchange, then lost the final response. The command failed after 41.844 seconds and the user confirmed that the bolt remained unlocked.

Alpha.42 requires an ESPHome advertisement no older than one second before starting a command connection. It also honors the SDK's eight-second command-only connection timeout instead of silently extending it to 18 seconds; longer full-metadata sessions retain their existing timeout. This prevents an obsolete connection attempt from consuming the lock's usable BLE command window and lets the existing bounded retry start sooner. Authentication, command payloads, response validation, notification cleanup, 100 ms fragment pacing, and the two-attempt limit are unchanged. Alpha.42 remains awaiting a supervised no-keypad-wake test.

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
