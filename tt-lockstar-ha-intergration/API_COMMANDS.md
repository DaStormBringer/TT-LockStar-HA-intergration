# TT LockStar WebSocket Command API

> [!CAUTION]
> This API controls a physical lock and exposes sensitive credential data. Keep it behind Home Assistant authentication on a trusted local network. Do not treat a software success response as physical bolt verification.

Alpha.48 adds a generic, capability-discoverable API at the existing `/api` WebSocket endpoint. Existing frontend message types such as `status`, `lock`, `unlock`, `credentials`, `settings`, and `firmware` remain supported.

## Discover commands

Request:

```json
{"type":"capabilities"}
```

Response:

```json
{
  "type": "capabilities",
  "data": {
    "commands": [
      {
        "name": "lock.time.get",
        "risk": "read_only",
        "readOnly": true,
        "requiresAddress": true,
        "confirmationRequired": false,
        "autoDisconnect": true,
        "args": {}
      }
    ]
  }
}
```

The runtime response is authoritative for the installed add-on version.

## Execute a command

```json
{
  "type": "command",
  "data": {
    "name": "lock.device_info.get",
    "address": "AA:BB:CC:DD:EE:FF",
    "args": {"infoType": "FIRMWARE_REVISION"}
  }
}
```

A successful response uses type `command` and includes `name`, normalized uppercase `address`, `success`, `result`, `risk`, and `readOnly`. Errors use the existing `error` response type and include the original request.

Commands with `confirmationRequired: true` require this exact, case-sensitive value:

```text
COMMAND_NAME AA:BB:CC:DD:EE:FF
```

For example, a supervised physical unlock request is shaped as follows:

```json
{
  "type": "command",
  "data": {
    "name": "lock.unlock",
    "address": "AA:BB:CC:DD:EE:FF",
    "confirm": "lock.unlock AA:BB:CC:DD:EE:FF"
  }
}
```

Confirmation protects the generic API from accidental calls; it does not make unattended physical operation safe. Each physical command still requires a current door/bolt assessment and manual verification during this experimental phase.

## Command catalog

System and lifecycle:

- `system.scan.start`, `system.scan.stop`
- `lock.pair`, `lock.disconnect`
- `lock.reset`

Physical control and state:

- `lock.lock`, `lock.unlock`
- `lock.status.get`
- `lock.operations.get`

Information and settings:

- `lock.device_info.get`
- `lock.time.get`, `lock.time.sync`
- `lock.auto_lock.get`, `lock.auto_lock.set`
- `lock.audio.get`, `lock.audio.set`
- `lock.proactive_logs.get`, `lock.proactive_logs.set`
- `lock.remote_unlock.get`, `lock.remote_unlock.set`

Passage mode:

- `lock.passage_mode.get`
- `lock.passage_mode.set`, `lock.passage_mode.delete`, `lock.passage_mode.clear`

Credentials:

- `lock.credentials.get`
- `credential.passcode.get`, `credential.passcode.add`, `credential.passcode.update`, `credential.passcode.delete`, `credential.passcode.clear`
- `credential.card.get`, `credential.card.add`, `credential.card.update`, `credential.card.delete`, `credential.card.clear`
- `credential.fingerprint.get`, `credential.fingerprint.add`, `credential.fingerprint.update`, `credential.fingerprint.delete`, `credential.fingerprint.clear`

## Important arguments

- Addresses use `AA:BB:CC:DD:EE:FF` format.
- `forceRefresh` is an optional boolean for credential and operation-log reads.
- Dates use `YYYYMMDDHHmm`.
- Passcodes contain 4 through 9 digits; types are 1 through 4 as defined by the pinned SDK.
- `lock.auto_lock.set` accepts `seconds` from 0 through 300; zero disables auto-lock.
- Audio, proactive-log, and remote-unlock setters accept an `enabled` boolean.
- Passage-mode data is `{type, weekOrDay, month, startHour, endHour}`. `type` is `WEEKLY`, `MONTHLY`, 1, or 2; hours use `HHmm`.
- `lock.device_info.get` accepts `MODEL_NUMBER`, `HARDWARE_REVISION`, `FIRMWARE_REVISION`, `MANUFACTURE_DATE`, `MAC_ADDRESS`, `LOCK_CLOCK`, `NB_OPERATOR`, `NB_IMEI`, `NB_CARD_INFO`, or `NB_RSSI`. Unsupported fields may still be rejected by a particular lock.

Use `capabilities` for exact argument metadata and risk classification rather than hard-coding this document alone.

## Safety and scope boundaries

The generic API covers the practical public high-level operation surface in the pinned `ttlock-sdk-js` version. BLE connection and disconnection are normally managed automatically, and a command marked `autoDisconnect` closes its session in a `finally` path.

The following are intentionally not exposed:

- Protected SDK protocol internals, AES/admin-key reads, raw command construction, and arbitrary GATT writes.
- Firmware update. `FIRMWARE_REVISION` is read-only device information, not OTA support.
- A direct `getLockStatus` query on the tested room deadbolt. The pinned SDK's command represents a bicycle-lock status path and is not valid deadbolt evidence for this M302. `lock.status.get` therefore returns only the last state confirmed by a successful local command or explicit operation-log record, plus the separately tracked magnetic door contact.
- Automatic retries for credential, passage-mode, remote-unlock, settings, clear-all, or reset mutations. Repeating those operations could create duplicate or destructive effects.

ESPHome GATT caching in alpha.48 caches only the discovered service table and MTU within the running bridge process. It never caches TTLock authentication challenges and automatically invalidates before an uncached retry if a cached connection or handle fails.
