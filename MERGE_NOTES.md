# TTLock local merge notes

## Sources

- Home Assistant/add-on base: `PiexlPuck/hass-addons` at branch `master`
- Merged history and reliability changes: `RK392/hass-addons` at branch `master`
- SDK: `RK392/ttlock-sdk-js` pinned to commit `42043c41f8f4c88234d2b70ab6a067a610679ffb` (`v0.3.34`)
- Original project: `kind3r/hass-addons` and `kind3r/ttlock-sdk-js`

The repository keeps `origin` pointed at PiexlPuck and an `rk392` remote pointed at RK392. The working branch is `codex/merge-rk392`.

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
- The Vue production frontend builds successfully. Its warnings are existing Vue 2/Vuetify 2 deprecations, console lint warnings, and bundle-size warnings; there are no compile errors.
- The pinned SDK resolves as version 0.3.34 and its required lock-time/proactive-log methods are present in the pinned source.
- A complete Home Assistant add-on image build still belongs in Linux/Docker because Noble is a native Bluetooth dependency and the image target is Alpine Linux. Docker CLI is installed on this workstation, but the Docker Desktop Linux engine was not running during this merge.
- Hardware validation requires an explicit, supervised test with a direct Bluetooth adapter near the lock. No install, pairing, reset, lock, or unlock operation was performed as part of this merge.
