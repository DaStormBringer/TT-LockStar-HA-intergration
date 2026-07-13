# Changelog

## [0.1.0-alpha.53] - 2026-07-13

- Preserve the evidence-backed lock entity while separately decoding the passive BLE `isUnlock` and `hasEvents` advertisement bits.
- Expose an experimental `Advertised Lock State` diagnostic through MQTT discovery, WebSocket lock status, and read-only `lock.status.get` evidence. A clear bit is labeled `IDLE_NO_UNLOCK_SIGNAL`, never `LOCKED`.
- Keep advertisement observations process-local, timestamped, explicitly unconfirmed, and rate-limit unchanged MQTT/WebSocket updates to once every 30 seconds while publishing semantic changes immediately.
- Pass 98 JavaScript tests and 8 ESPHome bridge tests in the built `amd64` image; verify add-on 0.1.0-alpha.53, SDK 0.3.34, and 41 exposed commands.
- Validate the deployed M302 passive path: Home Assistant reports `IDLE_NO_UNLOCK_SIGNAL` with `advertised_confirmed: false`, while the independent confirmed deadbolt state remains `UNKNOWN` and the magnetic contact reports `CLOSED`; no actuator command was sent.

## [0.1.0-alpha.52] - 2026-07-13

- Give only `lock.connection.prepare` up to 60 seconds to observe a qualifying sleeping-lock advertisement before it opens BLE; normal physical command advertisement and connection limits remain unchanged.
- Start the caller's 5–30 second prepared-session lease only after connection succeeds, so time spent waiting for the lock does not consume the reusable window.
- Record alpha.51's first live read-only preparation failure: no qualifying advertisement reached the strict gate within 15 seconds, the request failed closed, and no authentication or actuator command was sent.
- Pass 93 JavaScript tests and 8 ESPHome bridge tests in the built `amd64` image; verify add-on 0.1.0-alpha.52, SDK 0.3.34, and 41 exposed commands.

## [0.1.0-alpha.51] - 2026-07-13

- Add read-only `lock.connection.prepare`, which opens a command-ready BLE session and holds it for a caller-selected 5 through 30 seconds (15 seconds by default) so the next command can reuse it. It does not pre-authenticate or bypass the following command's authentication.
- Automatically disconnect an unused prepared session at its deadline, release the connection mutex after an unexpected link loss, and leave exact per-lock confirmation unchanged for physical lock/unlock commands.
- Record the physically confirmed alpha.50 unlock: 7.287 seconds total, dominated by a 5.584-second wait for the sleeping M302's next advertisement; the cached connection took 1.100 seconds and authenticated unlock took 601 milliseconds.
- Keep prepared-session automation disabled pending a supervised test proving that an early presence event can absorb the advertisement delay without unacceptable battery or TTLock app/G2 contention.
- Pass 92 JavaScript tests and 8 ESPHome bridge tests in the built `amd64` image; verify add-on 0.1.0-alpha.51, SDK 0.3.34, and 41 exposed commands. The inherited audit count remains 7 moderate, 7 high, and 2 critical.

## [0.1.0-alpha.50] - 2026-07-13

- Bound a speculative cached ESPHome BLE connection to four seconds before falling back to a normal service-discovery connection.
- Preserve the known GATT table after a connection timeout; a timeout does not prove the characteristic handles are stale, and explicit GATT-failure recovery can still clear both local and remote caches.
- Add bridge regressions for bounded cached-connect fallback, cache preservation, and explicit cache clearing.
- Record the alpha.49 supervised M302 cycle: unlock succeeded physically in 1.84 seconds; lock succeeded physically in 18.14 seconds, of which 13.813 seconds were BLE/GATT connection setup after a cached-connect timeout.
- Pass 85 JavaScript tests and 8 ESPHome bridge tests in the built `amd64` alpha.50 image; verify the packaged SDK remains 0.3.34.

## [0.1.0-alpha.49] - 2026-07-13

- Add optional top-level string or numeric `requestId` correlation to generic `capabilities` and `command` requests, their direct replies, and command errors. Legacy clients that omit the field retain the existing response shape.
- Keep asynchronous `status` and `lockStatus` broadcasts uncorrelated so clients can distinguish them from the requested terminal reply.
- Log connection-mutex waits and fresh-advertisement waits separately from BLE connection and authenticated-command timing.
- Correct the stale README statement that described alpha.48 cached-GATT hardware timing as pending.
- Pass 85 JavaScript tests and 7 ESPHome bridge tests in the built `amd64` alpha.49 image; verify the packaged SDK remains 0.3.34 with 40 exposed commands.
- Leave advertisement freshness, retry, authentication, command payload, response validation, and disconnect behavior unchanged. No physical command is required to validate this release build.

## [0.1.0-alpha.48] - 2026-07-13

- Add a capability-discoverable WebSocket command API covering the complete supported high-level operation surface of the pinned TTLock SDK: state evidence, device information, time, auto-lock, audio, passage mode, remote-unlock configuration, credentials, logs, pairing, reset, and physical lock/unlock.
- Require an exact command-name and lock-address confirmation for actuator, security-sensitive, and destructive generic commands. Preserve the existing frontend WebSocket messages for compatibility.
- Use command-only BLE sessions for individual reads, settings, credentials, and log operations instead of performing a full metadata refresh first.
- Cache a successfully discovered ESPHome GATT service table and MTU within the bridge process, reuse ESPHome's cached-connect mode on later sessions, and invalidate/retry uncached if a cached connection or handle fails.
- Add authenticated-command phase timing without skipping TTLock authentication, response validation, notification registration, or physical-state verification.
- Pass 82 JavaScript tests and 7 ESPHome bridge tests.
- Validate the cached GATT path on the physical M302: a supervised unlock connected in 2.019 seconds, completed its authenticated command phase in 624 milliseconds, returned success in 7.853 seconds total, and was physically confirmed. This single sample does not establish a latency improvement over alpha.47.

## [0.1.0-alpha.47] - 2026-07-13

- In direct ESPHome advertisement mode, discover paired locks without automatically consuming their first connectable wake for a full metadata refresh.
- Preserve that first connection for an explicit firmware, status, or actuator request; no actuator command is added or changed.
- Keep shared Home Assistant advertisement behavior unchanged.
- Validate the read-only firmware route on the user's physical M302, which returned firmware `6.4.43.24052101` through the dedicated Craft ESPHome proxy.

## [0.1.0-alpha.46] - 2026-07-13

- Infer a missing static-random BLE address type when Home Assistant's shared advertisement feed omits `address_type`, while preserving explicit types supplied by ESPHome.
- Keep the ESPHome bridge request open long enough for the existing second-proxy candidate to return instead of orphaning the failover after 25 seconds.
- Preserve the firmware route's read-only command and 60-second keypad-wake reservation.

## [0.1.0-alpha.45] - 2026-07-13

- Reserve a paired lock while a read-only firmware request is armed so a queued startup metadata refresh cannot consume the next keypad wake.
- Let the firmware request wait up to 60 seconds for a fresh lock advertisement before opening its command-only BLE connection.
- Keep the route read-only: it sends only `COMM_READ_DEVICE_INFO` with `FIRMWARE_REVISION` and never sends lock, unlock, settings, time-sync, or firmware-update commands.

## [0.1.0-alpha.44] - 2026-07-13

- Add a dedicated read-only `firmware` WebSocket request for paired locks.
- Use a command-only BLE connection and TTLock `COMM_READ_DEVICE_INFO` with `FIRMWARE_REVISION`; do not send an actuator, settings, time-sync, or firmware-update command.
- Return the requested revision, the generic GATT firmware value when available, the exact command and info type, and an explicit `readOnly` marker before disconnecting.
- Add regression coverage for command selection, command-only connection policy, response framing, and post-request disconnect routing.

## [0.1.0-alpha.43] - 2026-07-13

- Consume Home Assistant's authenticated `bluetooth/subscribe_advertisements` WebSocket feed by default so Home Assistant retains ownership of each ESPHome proxy's single advertisement subscription.
- Keep direct ESPHome native API clients connection-only for active scan mode, connection-slot reporting, GATT connections, reads, writes, and notifications.
- Map Home Assistant's scanner `source` address back to each configured ESPHome proxy before surfacing a fresh lock advertisement, preserving signal-aware proxy selection without a race against the command freshness gate.
- Retain the former direct advertisement subscription only as an explicit `direct` diagnostic option; never fall back to it automatically.
- Add JavaScript coverage for Home Assistant WebSocket authentication, subscription, advertisement normalization, and proxy mapping, plus Python coverage for scanner-source routing.
- This release requires a deployed read-only firmware/version request before the new shared-feed path is considered hardware validated; no actuator behavior changes are included.

## [0.1.0-alpha.42] - 2026-07-13

- Require an ESPHome lock advertisement no older than one second before starting a command connection; other Bluetooth transports retain the existing ten-second freshness window.
- Honor the SDK's eight-second ESPHome command-only connection timeout instead of silently extending it to 18 seconds. Full metadata connections retain their existing longer timeout.
- Preserve authentication selection, command payloads, response validation, notification resubscription, 100 ms fragment pacing, and the bounded two-attempt fail-closed policy.
- Record alpha.41's supervised first-attempt unlock, lock, and unlock successes at 6.815, 1.722, and 4.262 seconds, with every bolt movement physically confirmed.
- Record the no-keypad-wake failure: attempt one started from a 9.987-second-old packet and timed out; attempt two connected from a 50 ms-old packet but lost the final lock response; the bolt remained physically unlocked after 41.844 seconds.

## [0.1.0-alpha.41] - 2026-07-13

- Clear ESPHome GATT notification callbacks whenever the BLE link disconnects and defensively before reconnecting, so every new lock session sends a fresh start-notify request instead of trusting a stale subscription marker.
- Add regression coverage that scopes cleanup to the disconnected lock and proves a second session reissues notification registration.
- Preserve administrator unlock authentication, user-time lock authentication, 100 ms multipart pacing, authenticated response validation, the two-attempt limit, and fail-closed behavior.
- Record alpha.40's supervised unlock failure: both attempts connected and wrote the administrator-check fragments but disconnected waiting for the response; no actuator command was sent and the user confirmed that the bolt remained locked.

## [0.1.0-alpha.40] - 2026-07-13

- Pace ESPHome multipart write-without-response fragments at 100 ms instead of 20 ms. The ESPHome API acknowledges only local queueing for this write type, so the added interval gives the proxy time to transmit one fragment before accepting the next.
- Preserve the single ordered Node-to-bridge request, authenticated `CHECK_USER_TIME` lock flow, administrator unlock flow, response validation, two-attempt limit, and fail-closed behavior.
- Record alpha.39's supervised lock failure: both attempts connected in under 1.4 seconds but disconnected while waiting for the `CHECK_USER_TIME` response; the user confirmed that the bolt remained unlocked.
- Record the comparison phone-app lock: the same M302 locked successfully, and its advertisements transitioned from `newEvents: true` to `lockedStatus: true`, confirming the actuator and ESPHome observation path while isolating the failure to the add-on's outbound GATT exchange.

## [0.1.0-alpha.39] - 2026-07-13

- Revert only alpha.38's administrator-authentication change for locking: lock again uses the pinned SDK's `CHECK_USER_TIME` path, while the physically validated administrator unlock continues to use `CHECK_ADMIN`.
- Record alpha.38's supervised failure: both bounded lock attempts connected through the Living Room ESPHome proxy and disconnected while waiting for the administrator-check response, before the actuator payload; the user confirmed the bolt remained unlocked.
- Align the implementation with the official React Native wrapper's generic `controlLock(LOCK, lockData)` boundary and the pinned SDK analysis, which documents administrator authentication for unlock but the user-time check for lock.
- Preserve the lock payload, AES and unlock keys, authenticated response validation, ESPHome fragment batching, retry limits, and fail-closed behavior.

## [0.1.0-alpha.38] - 2026-07-13

- Use TTLock's documented administrator lock path and `CHECK_ADMIN` challenge before locking when the imported key contains an administrator password; ordinary eKeys retain `CHECK_USER_TIME`.
- Keep the authenticated lock payload, AES key, unlock key, response validation, retry limits, and fail-closed behavior unchanged.
- Record alpha.37's first physically confirmed administrator-authenticated ESPHome proxy unlock: attempt one returned success in 3.60 seconds and the user confirmed the bolt retracted.
- Record the following relock failure: the legacy `checkUserTime` exchange disconnected before the actuator command, the retry timed out connecting, and the user confirmed the bolt remained unlocked.

## [0.1.0-alpha.37] - 2026-07-13

- Use TTLock's documented `CHECK_ADMIN` challenge before unlock when the imported key contains an administrator password; ordinary eKeys retain `CHECK_USER_TIME`.
- Keep the authenticated unlock payload, AES key, unlock key, response validation, and fail-closed behavior unchanged.
- Record alpha.36's first physically confirmed ESPHome lock: authenticated success on attempt one in 4.66 seconds, with the user confirming the bolt extended.
- Record three following supervised unlock failures: the back-to-back attempt could not reconnect, while later attempts connected but disconnected during `checkUserTime`; no unlock actuator payload was sent and the user confirmed the bolt remained locked each time.

## [0.1.0-alpha.36] - 2026-07-12

- Batch each multipart TTLock command into one ordered Node-to-ESPHome bridge request while retaining 20 ms BLE fragment pacing.
- Keep the authenticated `checkUserTime` challenge and command response requirements unchanged; no nonce is cached or bypassed.
- Record the first physically confirmed local ESPHome proxy unlock: alpha.35 connected through the Living Room proxy and completed the authenticated unlock in 2.67 seconds.
- Record two subsequent supervised relock failures: both connected and failed during `checkUserTime`, before the lock actuator payload was written; the user confirmed the bolt remained unlocked after each failure.
- Add JavaScript and Python regression coverage for ordered batched proxy writes.

## [0.1.0-alpha.35] - 2026-07-12

- Give only the ESPHome proxy command path a 45-second outer connection window; raw HCI, Noble D-Bus, and native BlueZ retain their existing 12-second command cutoff.
- Raise the ESPHome GATT connection request floor from 10 to 18 seconds.
- Keep the Node-to-Python bridge request alive through aioesphomeapi's bounded failed-connect cleanup so a second attempt cannot overlap a stale proxy connection.
- Record the first supervised ESPHome proxy unlock attempt: both bounded connection attempts timed out before any unlock payload was written, and the user confirmed the deadbolt remained locked.

## [0.1.0-alpha.34] - 2026-07-12

- Subscribe to ESPHome raw advertisement batches when the proxy advertises that feature, with a parsed-message fallback for older proxies.
- Decode standard BLE advertisement fields locally, including 16/32/128-bit service UUIDs, names, service data, and manufacturer data.
- Request active scan mode after claiming the proxy's single Bluetooth subscription for compatibility with the deployed ESPHome firmware.
- Add a regression test built from the captured M302 wake packet.
- Record the sole-subscriber capture: the Living Room proxy received five M302 packets at approximately -81 to -79 dBm; the Master Bedroom proxy delivered no packets during that window.

## [0.1.0-alpha.33] - 2026-07-12

- Accept an ESPHome advertisement from the exact MAC address of a stored paired lock even when the packet omits TTLock service UUID `1910`.
- Keep UUID filtering for every unknown address, so unrelated Bluetooth advertisements are not passed into the TTLock SDK.
- Add deterministic coverage proving a paired M302 address passes the filter while an unrelated UUID-less address remains rejected.

## [0.1.0-alpha.32] - 2026-07-12

- Explicitly request active scanning whenever the local ESPHome proxy bridge connects, so short M302 keypad-wake advertisements are less likely to be missed.
- Require ESPHome scanner state/mode support in addition to active connections and remote GATT caching.
- Log the proxy name and RSSI for matching TTLock advertisements, plus the selected proxy and MTU after a connection.
- Document ESPHome's single Bluetooth API subscriber behavior: every configured proxy is dedicated to TT LockStar while the add-on owns its advertisement subscription.
- Stop printing a misleading local `hci0` selection message when the ESPHome proxy transport is selected.

## [0.1.0-alpha.31] - 2026-07-12

- Add a fully local ESPHome Bluetooth Proxy transport using the ESPHome native API; TTLock Cloud and the G2 gateway are not involved.
- Support multiple configured proxies, recent-advertisement and signal-aware proxy selection, connection-slot reporting, active BLE connections, GATT enumeration, reads, writes, descriptors, and notifications.
- Keep the existing JavaScript TTLock credential, encryption, command, and authenticated-response layers unchanged behind the new transport adapter.
- Keep proxy scanning active during command connections, retain the fresh-advertisement safety gate, and preserve bounded command attempts.
- Mark the transport very experimental pending read-only proxy validation and supervised physical command testing.

## [0.1.0-alpha.30] - 2026-07-12

- Record a second physically confirmed native BlueZ round trip: after a keypad wake, unlock completed in 7.04 seconds and the immediate lock completed in 9.34 seconds; both succeeded on their second connection attempt.
- Keep native BlueZ discovery active while starting a command connection, avoiding the StopDiscovery-to-Connect adapter transition that repeatedly consumed the first attempt on the test hardware.
- Reduce the native BlueZ retry pause from 1.5 seconds to 100 ms after a connection is safely drained.
- Reduce only the native command-level BlueZ connection timeout from 6 seconds to 4.5 seconds; authenticated command/response handling and the two-attempt limit are unchanged.
- Leave raw HCI and Noble-backed D-Bus timing policies unchanged.

## [0.1.0-alpha.29] - 2026-07-12

- Record the first physically verified native BlueZ round trip on the front-door lock: unlock completed in 4.32 seconds and the user confirmed the bolt retracted.
- Record the immediately following lock: the first connection timed out without writing the lock command, then the bounded retry connected in 447 ms; the authenticated lock command completed in 9.17 seconds total and the user confirmed the bolt extended.
- Confirm the native `bluez` runtime loaded no Noble modules during validation.
- Rename shared BlueZ D-Bus diagnostic labels from `[Bluetooth][D-Bus]` to `[Bluetooth][BlueZ]` so native transport logs are not mistaken for the Noble-backed `dbus` transport.
- Keep native BlueZ opt-in and all unattended or automatic lock control out of scope while repeated-cycle reliability is still being established.

## [0.1.0-alpha.28] - 2026-07-12

- Record that alpha.27 performed a real second native BlueZ connection attempt, but both attempts returned `le-connection-abort-by-local` before GATT setup or any unlock write.
- Correlate the failures with reuse of a cached BlueZ `Device1` object after the successful alpha.26 metadata session; the successful session used a newly rediscovered object.
- Remove only the target's host-unpaired BlueZ cache after native disconnect so the next wake produces a fresh `InterfacesAdded` device object.
- Preserve host-paired device objects and keep TTLock protocol credentials untouched.
- Add regression coverage for unpaired removal and paired-device preservation after disconnect.

## [0.1.0-alpha.27] - 2026-07-12

- Record that alpha.26 native BlueZ connected in about 10.3 seconds, completed multiple authenticated metadata reads and responses, and disconnected cleanly without loading Noble.
- Record that the first supervised unlock connection returned `le-connection-abort-by-local`; no unlock payload was written, and retry two exited immediately because the SDK retained its failed `connecting` flag.
- Drain and reset every failed Bluetooth setup, not only outer timeouts, so the manager's bounded retry performs a real second BlueZ connection attempt.
- Add regression coverage for native BlueZ connection errors leaving the SDK in a retryable state.

## [0.1.0-alpha.26] - 2026-07-12

- Record that a synchronized alpha.25 awake-keypad test still produced no Noble discovery or update event; both attempts failed closed before connecting or writing a command.
- Add a native `bluez` transport that bypasses Noble and talks directly to BlueZ through its D-Bus Device and GATT interfaces.
- Preserve the TTLock SDK's protocol, encryption, credentials, command, and response layers behind native scanner, device, service, characteristic, and descriptor adapters.
- Keep `raw_hci` and the Noble-backed `dbus` path available as comparison fallbacks while native BlueZ receives supervised hardware validation.
- Add native transport selection, adapter routing, command-fragment pacing, identifier conversion, manufacturer-data conversion, and GATT-flag tests.

## [0.1.0-alpha.25] - 2026-07-12

- Record that alpha.24 received a live SDK `lockUpdated` wake event, but the D-Bus Noble path did not emit the separate `foundLock` event watched by the freshness gate; both unlock cycles failed closed before connecting or writing a command.
- Treat the SDK's live lock update as a fresh advertisement and copy its timestamp to the stored command lock.
- Do not let an advertisement update disconnect or release the mutex of a command that is waiting for that same wake signal.
- Add regression coverage for copying a live update timestamp between the discovered and stored lock instances.

## [0.1.0-alpha.24] - 2026-07-12

- Record that alpha.23 safely refreshed only the target's unpaired BlueZ cache and wrote no command when the lock did not rediscover during either freshness window.
- Record that waking the keypad produced a live advertisement at approximately -76 dB, but the manual delay before the test exceeded the former one-second freshness limit.
- Wait up to 15 seconds for a keypad wake advertisement before refreshing the target cache.
- Accept an advertisement up to 10 seconds old so a freshly awakened lock remains eligible while the command begins connecting.

## [0.1.0-alpha.23] - 2026-07-12

- Record that alpha.22 still received no live property update from the lock and correctly wrote no command during either freshness window.
- If no duplicate advertisement arrives within 1.5 seconds, remove only the target's unpaired stale BlueZ device object and wait for a real `InterfacesAdded` rediscovery.
- Refuse the cache refresh when BlueZ reports the target as paired, protecting host-level pairing keys.
- Keep TTLock protocol credentials and all other Bluetooth devices untouched.
- Add regression coverage for binding discovery, targeted refresh, and the paired-device safety guard.

## [0.1.0-alpha.22] - 2026-07-12

- Record that alpha.21 correctly failed closed because the D-Bus transport produced no duplicate Noble discovery event within either six-second freshness window; no lock command was written.
- Attach a BlueZ `PropertiesChanged` listener to discovered devices while scanning.
- Translate live RSSI, manufacturer, service-data, UUID, and name changes into Noble duplicate discovery events.
- Reattach the listener after disconnect without treating BlueZ's cached device object as a fresh advertisement.
- Add fail-closed patch guards and regression coverage for the D-Bus duplicate-discovery bridge.

## [0.1.0-alpha.21] - 2026-07-12

- Record that alpha.20 failed safely before writing a command: both BlueZ connection attempts returned `org.bluez.Error.Failed: le-connection-abort-by-local`, and the user confirmed the deadbolt stayed locked.
- Wait up to six seconds for an advertisement no older than one second before a D-Bus connection attempt.
- Allow 250 ms for this App's BlueZ discovery stop to settle before calling `Device1.Connect`; raw-HCI timing is unchanged.
- Keep actual `Peripheral connect error` messages visible when communication debug is disabled.
- Add deterministic coverage for fresh-advertisement success and fail-closed timeout behavior.

## [0.1.0-alpha.20] - 2026-07-12

- Record the supervised alpha.19 BlueZ D-Bus unlock failure: the adapter connected in under two seconds on the second attempt, but the lock disconnected while `checkUserTime` waited for its response and the physical deadbolt stayed locked.
- Pace multipart D-Bus write-without-response commands by 20 ms between ATT-sized fragments; raw-HCI behavior is unchanged.
- Log only fragment number, count, and length on the D-Bus command path so the next supervised test can distinguish a complete write from a notification failure without exposing command payloads.
- Add fail-closed regression coverage for the transport-specific pacing patch.

## [0.1.0-alpha.19] - 2026-07-12

- Record the supervised alpha.18 unlock failure: the command remained fail-safe and the user confirmed the physical deadbolt stayed locked.
- Wait for Noble's pending raw-HCI connection slot to drain after cancellation before allowing a retry.
- Do not issue `cancelConnect` against a connection that has already completed; disconnect that handle normally instead.
- Suppress the retry when cancellation does not drain, preventing a known-stale second connection attempt.
- Add elapsed-time logs for connection setup, attempts, command success, and final failure.
- Add regression coverage for drained and undrained HCI cancellation states.

## [0.1.0-alpha.18] - 2026-07-12

- Record the alpha.17 supervised timing results: a lock command completed physically in about 18 seconds, while the following unlock timed out and correctly left the door locked.
- Reset every SDK connection layer after the outer command timeout so a late background connection cannot poison the next retry.
- Cancel an in-progress raw-HCI connection and disconnect a connection that completes after its deadline.
- Limit command-only BLE discovery to TTLock service `1910` and discover its characteristics without reading every readable value first.
- Stop command-only reconnects from publishing an advertisement-inferred deadbolt state before the physical command completes.
- Add regression coverage for timeout cleanup and targeted service discovery.

## [0.1.0-alpha.17] - 2026-07-12

- Record a timed alpha.16 unlock that exposed state after 7.5 seconds but required about 55 seconds for physical movement and the definitive command response.
- Stop forcing every Noble connection to wait at least 40 seconds.
- Give command-only raw-HCI connections a 6-second device timeout while preserving the long timeout for full metadata reads.
- Remove the SDK's five nested retries for command-only connects so the manager can restart monitoring and rediscover a fresh peripheral.
- Limit lock/unlock to two manager attempts separated by a 1.5-second rediscovery window.
- Add regression coverage for the separate command and metadata timeout policies.

## [0.1.0-alpha.16] - 2026-07-12

- Record that alpha.15 made three fresh BLE connections but each disconnected while `checkUserTime` awaited the lock response.
- Add a `bluetooth_transport` option with `raw_hci` and `dbus` choices.
- Default new and upgraded installations without an explicit transport to the raw-HCI path that passed the supervised alpha.13 physical lock/unlock cycle.
- Retain the maintained Noble D-Bus implementation and alpha.15 patches as an explicit experimental transport.
- Validate both Noble package versions during the fail-closed SDK patch step and route the SDK's legacy imports to the selected runtime.
- Build and load the raw-HCI native binding on the current Home Assistant amd64 Node 24 base.
- Document the increased dependency-audit risk introduced by the legacy fallback.
- Complete a supervised open-door physical unlock/lock cycle. Unlock succeeded on the first attempt, but the immediate relock exhausted all retries with a stale raw-HCI session. Restarting only the add-on cleared the session, after which lock succeeded on the first attempt. Physical bolt movement and Home Assistant state agreed throughout.

## [0.1.0-alpha.15] - 2026-07-12

- Record two failed supervised alpha.14 unlock tests, including an open-door, extended-bolt, awake-keypad test that excluded strike resistance.
- Keep the maintained Noble D-Bus object cache synchronized with live BlueZ device properties.
- Clear cached `Connected` and `ServicesResolved` flags when BlueZ reports a remote disconnect so retries cannot reuse a dead session.
- Pass the existing command-only policy into the Bluetooth device setup layer.
- Discover the TTLock service but skip cached GAP/device-information reads before lock and unlock commands, reducing the time before `checkUserTime` and the physical command.
- Add fail-closed patch guards and regression tests for both D-Bus state invalidation and the command-only fast path.

## [0.1.0-alpha.14] - 2026-07-12

- Replace the unmaintained `@abandonware/noble` runtime with an npm alias to maintained `@stoprocent/noble` 2.5.5.
- Override the pinned TTLock SDK's nested Noble dependency so no legacy raw-HCI copy remains in the image.
- Use the fork's BlueZ D-Bus backend instead of direct raw-HCI ownership, while preserving the configured `hciN` adapter.
- Add the D-Bus peer dependency explicitly and validate the installed transport during the existing fail-closed postinstall patch.
- Skip unused native-HCI dependency install hooks, then explicitly check out and compile the pinned TTLock SDK commit before running the guarded patch step.
- Compile the legacy SDK against its matching Noble type declarations while keeping the maintained fork as the only runtime implementation.
- Omit optional native socket/HCI packages that the D-Bus transport does not use.
- Remove the raw-HCI compiler, Python, libcap, and Bluetooth development packages from the runtime image.
- Prune build-only TypeScript packages, the temporary SDK checkout, and npm caches from the final image.
- Restore the legacy `with-bindings` module path required by the SDK's eagerly loaded but disabled websocket scanner.
- Retain the alpha.13 command-only connection policy and stale-peripheral safeguards for comparative hardware testing.

## [0.1.0-alpha.13] - 2026-07-12

- Use the SDK's command-only connection mode for lock and unlock instead of requiring a full metadata refresh first.
- Add an outer 55-second connection timeout so a hung SDK/Noble promise cannot hold the per-lock mutex forever.
- Log API and MQTT command receipt plus each physical-command connection attempt without exposing lock credentials.
- Pass a supervised physical unlock and lock cycle on M302 hardware, with Home Assistant state confirmation for both commands.

## [0.1.0-alpha.12] - 2026-07-12

- Mark the MQTT lock unavailable when deadbolt position is unknown so Home Assistant cannot retain a misleading prior state.
- Sanitize null-padded advertised names and use a stable address-based fallback before full lock metadata is available.

## [0.1.0-alpha.11] - 2026-07-12

- Publish migrated unknown deadbolt state and MQTT discovery as soon as a paired lock is seen, without waiting for a successful BLE connection.

## [0.1.0-alpha.10] - 2026-07-12

- Correct an upstream SDK classification that treated magnetic door-contact events as deadbolt lock/unlock evidence.
- Invalidate legacy inferred lock state once on upgrade and publish unknown until the newest operation explicitly confirms bolt position.
- Expose the magnetic contact as a separate Home Assistant MQTT door binary sensor with persisted open/closed state.
- Label contact records separately from deadbolt records in operation-log data.

## [0.1.0-alpha.9] - 2026-07-11

- Reconcile confirmed lock state during a forced/manual operation-log refresh as well as proactive event handling.
- Avoid publishing duplicate lock/unlock events when a refreshed log confirms the state already reported to Home Assistant.
- Honor the proactive log-fetch setting during initial discovery instead of always reading the log at startup.

## [0.1.0-alpha.8] - 2026-07-11

- Treat the newest explicit lock/unlock operation-log record as confirmed state evidence.
- Persist manual lock/unlock state and publish a single Home Assistant update.
- Stop comparing operation-log evidence with a stale command cache that could reverse the result.
- Keep proactive operation-log fetching opt-in because it adds BLE connections and auto-lock events may not be recorded by every lock firmware.

## [0.1.0-alpha.7] - 2026-07-11

- Initialize idle room deadbolts with unknown state instead of locked.
- Restore `lockedStatus` only when it was saved from a confirmed lock/unlock command.
- Keep imported `lockedStatus: -1` unknown until the first successful physical command.

## [0.1.0-alpha.6] - 2026-07-11

- Keep room-deadbolt state unknown instead of using the SDK's bicycle-status command as a position sensor.
- Persist a lock/unlock state only after the physical command returns success.
- Retain confirmed command state across App restarts.

## [0.1.0-alpha.5] - 2026-07-11

- Stop treating an idle `isUnlock=false` advertisement as proof that this deadbolt is locked.
- Preserve confirmed state until a successful command response, direct status read, or explicit unlock advertisement changes it.
- Return explicit errors for failed lock/unlock commands instead of sending misleading cached state.

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
