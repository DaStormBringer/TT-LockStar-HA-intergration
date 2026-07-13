# TT LockStar WebSocket Command API

> [!CAUTION]
> This API controls a physical lock and exposes sensitive credential data. Keep it behind Home Assistant authentication on a trusted local network. Do not treat a software success response as physical bolt verification.

Alpha.48 introduced a generic, capability-discoverable API at the existing `/api` WebSocket endpoint. Alpha.49 added optional request correlation. Alpha.51 added a bounded, read-only prepared connection for latency-sensitive local workflows, and alpha.52 gives preparation a longer sleeping-lock wake window. Existing frontend message types such as `status`, `lock`, `unlock`, `credentials`, `settings`, and `firmware` remain supported.

## Discover commands

Request:

```json
{"type":"capabilities","requestId":"capabilities-1"}
```

Response:

```json
{
  "type": "capabilities",
  "requestId": "capabilities-1",
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
  "requestId": "firmware-1",
  "data": {
    "name": "lock.device_info.get",
    "address": "AA:BB:CC:DD:EE:FF",
    "args": {"infoType": "FIRMWARE_REVISION"}
  }
}
```

A successful response uses type `command`, echoes `requestId` when supplied, and includes `name`, normalized uppercase `address`, `success`, `result`, `risk`, and `readOnly`. Errors use the existing `error` response type, echo the same optional `requestId`, and include the original request.

### Request correlation

`capabilities` and `command` requests may include an optional top-level `requestId` string or finite number. The corresponding `capabilities`, `command`, or `error` reply echoes that value at the top level. Broadcast messages such as `status` and `lockStatus` do not carry the caller's request ID, so clients can ignore those asynchronous updates while waiting for their matching direct reply. Clients that omit `requestId` receive the exact legacy response shape without a `requestId` field.

Commands with `confirmationRequired: true` require this exact, case-sensitive value:

```text
COMMAND_NAME AA:BB:CC:DD:EE:FF
```

For example, a supervised physical unlock request is shaped as follows:

```json
{
  "type": "command",
  "requestId": "unlock-1",
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
- `lock.pair`, `lock.connection.prepare`, `lock.disconnect`
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
- `lock.connection.prepare` accepts optional `holdSeconds` from 5 through 30 and defaults to 15.
- Dates use `YYYYMMDDHHmm`.
- Passcodes contain 4 through 9 digits; types are 1 through 4 as defined by the pinned SDK.
- `lock.auto_lock.set` accepts `seconds` from 0 through 300; zero disables auto-lock.
- Audio, proactive-log, and remote-unlock setters accept an `enabled` boolean.
- Passage-mode data is `{type, weekOrDay, month, startHour, endHour}`. `type` is `WEEKLY`, `MONTHLY`, 1, or 2; hours use `HHmm`.
- `lock.device_info.get` accepts `MODEL_NUMBER`, `HARDWARE_REVISION`, `FIRMWARE_REVISION`, `MANUFACTURE_DATE`, `MAC_ADDRESS`, `LOCK_CLOCK`, `NB_OPERATOR`, `NB_IMEI`, `NB_CARD_INFO`, or `NB_RSSI`. Unsupported fields may still be rejected by a particular lock.

Use `capabilities` for exact argument metadata and risk classification rather than hard-coding this document alone.

### Prepared connection

The sleeping lock can take several seconds to emit its next connectable advertisement. A local presence event may prepare the BLE/GATT session before a separately authorized action:

```json
{
  "type": "command",
  "requestId": "prepare-1",
  "data": {
    "name": "lock.connection.prepare",
    "address": "AA:BB:CC:DD:EE:FF",
    "args": {"holdSeconds": 15}
  }
}
```

Preparation is read-only and does not require actuator confirmation. It can wait up to 60 seconds for a sleeping lock's next qualifying advertisement; the requested 5–30 second lease starts only after the BLE connection succeeds. Preparation sends no authentication, lock, or unlock payload. If no following command claims the session, the add-on disconnects automatically at the lease deadline. A claimed session is still subject to the authentication, validation, and exact-confirmation requirements of the following command. Keep the lease short: an active session consumes lock battery and may temporarily contend with the TTLock app or G2 gateway.

## Safety and scope boundaries

The generic API covers the practical public high-level operation surface in the pinned `ttlock-sdk-js` version. BLE connection and disconnection are normally managed automatically, and a command marked `autoDisconnect` closes its session in a `finally` path.

The following are intentionally not exposed:

- Protected SDK protocol internals, AES/admin-key reads, raw command construction, and arbitrary GATT writes.
- Firmware update. `FIRMWARE_REVISION` is read-only device information, not OTA support.
- A direct `getLockStatus` query on the tested room deadbolt. The pinned SDK's command represents a bicycle-lock status path and is not valid deadbolt evidence for this M302. `lock.status.get` therefore returns only the last state confirmed by a successful local command or explicit operation-log record, plus the separately tracked magnetic door contact.
- Automatic retries for credential, passage-mode, remote-unlock, settings, clear-all, or reset mutations. Repeating those operations could create duplicate or destructive effects.

ESPHome GATT caching stores only the discovered service table and MTU within the running bridge process. Alpha.50 bounds a failed cached connection at four seconds, preserves the table on connection-only timeouts, and still permits explicit invalidation for GATT handle failures. It never caches TTLock authentication challenges. Alpha.51's prepared session is a live, automatically expiring BLE connection rather than cached authentication data.
