# TT-LockStar-HA-intergration merge notes

## Sources

- Home Assistant/add-on base: `PiexlPuck/hass-addons` at branch `master`
- Merged history and reliability changes: `RK392/hass-addons` at branch `master`
- SDK: `RK392/ttlock-sdk-js` pinned to commit `42043c41f8f4c88234d2b70ab6a067a610679ffb` (`v0.3.34`)
- Original project: `kind3r/hass-addons` and `kind3r/ttlock-sdk-js`

The repository keeps `origin` pointed at `DaStormBringer/TT-LockStar-HA-intergration`, preserves PiexlPuck as `upstream-piexlpuck`, and keeps `rk392` and `rk392-sdk` remotes for the imported reliability work. The working branch is `codex/merge-rk392`.

The public project name is `TT-LockStar-HA-intergration`, and the Home Assistant add-on slug is `tt-lockstar-ha-intergration`. This slug differs from the upstream `ttlock-hass-integration` identity and does not automatically migrate upstream add-on storage.

## Merge policy

PiexlPuck's newer Home Assistant 2026 packaging, direct Bluetooth adapter configuration, multi-lock UI, cache, manual refresh, and per-lock connection mutex are the base. Compatible RK392 features were ported onto that base:

- SDK v0.3.34 disconnect/retry and stale-response fixes
- Retry for lock/unlock operations, adapted to release PiexlPuck's mutex between attempts
- Lock time read/sync and Home Assistant MQTT discovery entities
- Optional proactive operation-log fetching
- Auto-lock range up to 300 seconds

RK392's older gateway configuration and generated frontend assets were not used because they conflict with the newer direct-adapter packaging and UI.

## G2 gateway boundary

The TTLock G2 gateway and its firmware remain independent. This add-on does not use the G2; it talks to the lock with a Bluetooth adapter directly attached or passed through to the Home Assistant host. Installing this development build must not require changing, downgrading, or factory-resetting the G2.

## Safety and security

- This is unofficial software with no upstream automated test suite.
- Pairing data, administrative material, credentials, and operation logs are stored locally by the add-on. Protect Home Assistant backups and add-on storage.
- Do not expose the ingress/API port directly to the internet.
- Validate read/status behavior first. Test unlock while physically present and retain a mechanical/keypad fallback.
- Do not unpair or reset the production lock until the local path has been proven stable.

## Current validation scope

- Backend JavaScript syntax checks pass with Node.js 24.
- The Vue production frontend built successfully before the final package rename. A full rebuild after the naming-only package change timed out in the legacy Vue 2 Windows toolchain, so the generated Ingress title was updated directly. The final Docker image was inspected and contains the renamed package, version, and title. A clean Linux CI rebuild remains desirable before a release candidate.
- The pinned SDK resolves as version 0.3.34 and its required lock-time/proactive-log methods are present in the pinned source.
- The complete `amd64` Home Assistant/Alpine image builds successfully in Docker Desktop as `tt-lockstar-ha-intergration:0.1.0-alpha.1`. The image contains compiled SDK v0.3.34 output and the expected lock-time/proactive-log methods.
- Loading Noble without host Bluetooth access reaches the expected `EAFNOSUPPORT` socket error. Hardware behavior still requires Home Assistant host networking, D-Bus, and a real Bluetooth adapter; Docker Desktop is not a substitute for that test.
- `npm audit --omit=dev` reports seven high-severity `tar` advisories through Noble's native installer chain (`bluetooth-hci-socket` -> `node-gyp`/`node-pre-gyp`). No non-breaking upstream fix is offered. Do not apply `npm audit fix --force`; these dependencies should be replaced or isolated in a future SDK/toolchain update.
- Hardware validation requires an explicit, supervised test with a direct Bluetooth adapter near the lock. No install, pairing, reset, lock, or unlock operation was performed as part of this merge.
