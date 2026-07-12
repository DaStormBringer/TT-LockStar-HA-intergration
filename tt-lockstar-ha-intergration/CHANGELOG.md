# Changelog

## [0.1.0-alpha.4] - 2026-07-11

- Refresh the underlying Noble peripheral object when a known lock is rediscovered.
- Prevent stale HCI handles from making all connections after the first successful session time out.
- Apply the reconnect fix only to the pinned `ttlock-sdk-js` 0.3.34 build and fail closed if its compiled structure changes.

## [0.1.0-alpha.3] - 2026-07-11

- Add an explicitly confirmed cloud-import path after strict validation.
- Merge imported pairing material by MAC instead of replacing unrelated stored locks.
- Return only a sanitized import confirmation; raw lock data and keys remain private.

## [0.1.0-alpha.2] - 2026-07-11

- Added validation-only retrieval of existing lock data from TTLock's official cloud API.
- Added guarded conversion from legacy TTLock cloud `lockData` to the local JavaScript SDK format.
- Added strict MAC, base64, AES, key-length, and administrative-value validation.
- Added sanitized validation responses that never return tokens or pairing secrets.
- Added local tests for valid conversion, tampering, MAC mismatch, and unsupported signed formats.

## [0.1.0-alpha.1] - 2026-07-11
- Merge PiexlPuck's Home Assistant 2026 packaging, local-adapter UI, caching, multi-lock support, and BLE connection mutex with RK392's TTLock SDK v0.3.34 fixes
- Retry lock/unlock after mid-operation BLE disconnects while releasing the per-lock mutex between attempts
- Add lock-time sensor plus manual read/sync buttons through MQTT discovery
- Add optional proactive operation-log fetching and raise the auto-lock setting limit to 300 seconds
- Keep the TTLock G2 gateway path independent; this add-on communicates through a direct Bluetooth adapter attached to Home Assistant

The entries below are retained upstream development history from before the TT-LockStar project identity and version reset.

## [0.6.3] - 2026-06-18
- Implement lock connection mutex to serialize BLE commands and prevent concurrent connection collisions (e.g. setting auto-lock while fetching logs)
- Route lock status updates and pairing through the connection manager wrapper to guarantee mutex compliance

## [0.6.2] - 2026-06-18
- Add missing `disconnectLock` call after getting operation logs
- Prevent noble auto-monitoring race condition/crashes when querying the lock immediately after a disconnect

## [0.6.1] - 2026-06-18
- Fix startup crash caused by missing imports in backend manager module

## [0.6.0] - 2026-06-18
- Add persistent caching for credentials (PINs, cards, fingerprints) and operation logs to avoid redundant BLE connections
- Add manual "Refresh" buttons to both Operation Log and Credentials views to force updates from the lock
- Implement a global console wrapper/filter to hide verbose SDK debugging messages from supervisor logs unless `debug_communication` is enabled
- Add a "Permanent" toggle switch for IC Cards and Fingerprints, hiding date-time selectors and defaulting to standard permanent lifespans
- Restrict and disable the type selector dropdown in the PIN passcode dialog to enforce Permanent passcodes
- Fix a typo in `Passcode.vue` preventing `endDate` setting for passcodes

## [0.5.7] - 2026-06-18
- Speed up BLE connections by pausing background monitor/scanning during connection establishment
- Add connection concurrency protection per lock in status update handlers to prevent "Connect already in progress" errors
- Add explicit disconnect calls at the end of every WebSocket API action to release connection resources promptly
- Wrap status update event handlers in robust try-catch-finally blocks to avoid uncaught promise rejection errors

## [0.5.6] - 2026-06-04
- Fix an issue where the scan gets stuck on the setup screen and cannot display previously paired locks when discovered during scanning by immediately adding discovered paired locks to the manager's list.

## [0.5.5] - 2026-06-04
- Fix persistent "Failed to set adminPasscode" initialization error by monkey patching the underlying TTLock SDK to treat response code `0` (`ERROR_NONE`) as a successful operation, resolving admin password setup failures.

## [0.5.4] - 2026-06-03
- Add support for scanning and pairing a second/subsequent lock via a new "Add / Scan Lock" button in the locks list view
- Provide a clean way to stop or cancel BLE scans at any time via a "Stop Scan" button (available in the countdown banner, empty state card, and top app bar)
- Display descriptive pairing error feedback in the frontend (such as connection issues or already initialized errors) instead of silently failing
- Add an orange "Discovered" badge/chip to distinguish unpaired locks in the UI
- Implement backend `stopScan` WebSocket command API
- Propagate `initLock` errors to API client rather than swallowing them in the backend manager

## [0.5.3] - 2026-06-03
- Increase Bluetooth scan duration from 30 seconds to 60 seconds
- Add a reactive countdown timer overlay to the frontend Ingress UI showing seconds remaining during a scan

## [0.5.2] - 2026-06-03
- Fix peripheral connection canceled errors by dynamically overriding connection timeouts in ttlock-sdk-js (forcing timeouts up to 40/45s, critical for weak RSSI signals and slow Bluetooth virtual adapters)

## [0.5.1] - 2026-05-28
- Configure local Bluetooth adapter (`bluetooth_adapter` option in config)
- Extract Bluetooth device ID and export `NOBLE_HCI_DEVICE_ID`
- Suppress scary ENOENT file errors quietly on first-run boot
- Remove the outdated external noble websocket gateway option
- Add a premium Home screen empty state setup assistant with micro-animations
- Bump core dependencies (Express, WS, Async-MQTT, Noble) for maximum stability
- Bump SDK in attempt at fixing connect limbo

## [0.4.0] - 2021-03-27
- Monitor advertisement packets to detect lock/unlock status updates (detects unlock events using pin, fingerprint or card)
- Discovery should be more reliable now
- View operation log
- Optimise communication with the lock
- Add lock unpair
- Fixes on settings save

## [0.3.2] - 2021-03-16
- Fix some bugs related to aliases when adding a new card or fingerprint

## [0.3.1] - 2021-03-08
- Add aliases (friendly names) to cards and fingerprints

## [0.3.0] - 2021-01-22
- New layout separating settings and credentials
- Manage lock sound

## [0.2.31] - 2021-01-21
- Bump SDK for fixing gateway disconnection issues

## [0.2.24] - 2021-01-20
- Bump SDK for switch feature fix and remote unlock error during pairing
- Stop scan after a new unpaired lock is found
- Option to debug gateway messages (`gateway_debug: true` in config)

## [0.2.21] - 2021-01-17
- Bump SDK for stability fixes

## [0.2.19] - 2021-01-16
- Auto-lock management

## [0.2.16] - 2021-01-16
- Basic config editing UI for saving/restoring lock pairing data
- Option for communication debug (`debug_communication: true` in config)

## [0.2.12] - 2021-01-16
- Persist device state between HA restarts
- Option for MQTT debug (`debug_mqtt: true` in config)

## [0.2.11] - 2021-01-15
- Filter credentials type availability based on lock features
- Force noble in websocket mode to avoid missing BLE adapter
- Unstable connection fixes from SDK
- Status updates to all clients
- Reduce scan interval
- Option to ignore CRC errors (`ignore_crc: true` in config)

## [0.2.7] - 2021-01-12
- Add support for BLE Gateway (not TTLock G2 gateway)

## [0.1.1] - 2021-01-08
- Possible fix for discovering unpaired locks
- Debug found locks

## [0.1.0] - 2021-01-05
Initial release
