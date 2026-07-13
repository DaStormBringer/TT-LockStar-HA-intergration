'use strict';

const DEFAULT_FULL_CONNECT_TIMEOUT_MS = 55000;
const DEFAULT_COMMAND_CONNECT_TIMEOUT_MS = 12000;
const DEFAULT_HARD_CONNECT_TIMEOUT_MS = DEFAULT_FULL_CONNECT_TIMEOUT_MS;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1500;
const DEFAULT_ADVERTISEMENT_FRESHNESS_MS = 10000;
const DEFAULT_ADVERTISEMENT_WAIT_MS = 6000;
const DEFAULT_WAKE_ADVERTISEMENT_WAIT_MS = 15000;
const DEFAULT_COMMAND_RETRY_DELAY_MS = 1500;
const NATIVE_BLUEZ_COMMAND_RETRY_DELAY_MS = 100;
const LAST_ADVERTISEMENT_PROPERTY = '_ttLockstarLastAdvertisementAt';
const RETRY_SAFE_PROPERTY = '_ttLockstarRetrySafe';

class LockConnectTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Lock connection exceeded the ${timeoutMs}ms hard timeout`);
    this.name = 'LockConnectTimeoutError';
  }
}

function resetConnectionState(lock) {
  const bluetoothDevice = lock?.device;
  const nobleDevice = bluetoothDevice?.device;

  if (lock) {
    lock.connecting = false;
    lock.connected = false;
    lock.skipDataRead = false;
  }
  if (bluetoothDevice) {
    bluetoothDevice.connected = false;
    bluetoothDevice.disconnectedDuringSetup = true;
    bluetoothDevice.waitingForResponse = false;
    bluetoothDevice.responses = [];
  }
  if (nobleDevice) {
    nobleDevice.connecting = false;
    nobleDevice.connected = false;
    if (typeof nobleDevice.resetBusy === 'function') nobleDevice.resetBusy();
    nobleDevice.services = new Map();
  }

  return nobleDevice?.peripheral;
}

async function cancelStaleLockConnection(lock, cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
  if (lock) lock[RETRY_SAFE_PROPERTY] = false;
  const peripheral = resetConnectionState(lock);
  if (!peripheral) return false;

  const binding = peripheral?._noble?._bindings;
  const peripheralId = peripheral.uuid || peripheral.id;
  const pendingConnectionIsDrained = () => (
    peripheral.state !== 'connecting'
    && (!binding || binding._pendingConnectionUuid !== peripheralId)
  );

  if (!pendingConnectionIsDrained()) {
    try {
      if (typeof peripheral.cancelConnect === 'function') peripheral.cancelConnect();
    } catch (_) {
      // Noble throws if the connection completed between the state check and cancel.
    }
  }

  let timer;
  try {
    if (peripheral.state === 'connected' && typeof peripheral.disconnectAsync === 'function') {
      await Promise.race([
        peripheral.disconnectAsync(),
        new Promise(resolve => {
          timer = setTimeout(resolve, cleanupTimeoutMs);
        }),
      ]);
    } else {
      const deadline = Date.now() + cleanupTimeoutMs;
      while (!pendingConnectionIsDrained() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      }
    }
  } catch (_) {
    // Cleanup is best effort; the scanner will replace the stale peripheral.
  } finally {
    if (timer) clearTimeout(timer);
  }

  const retrySafe = pendingConnectionIsDrained() && peripheral.state !== 'connected';
  if (lock) lock[RETRY_SAFE_PROPERTY] = retrySafe;
  return retrySafe;
}

function isConnectionRetrySafe(lock) {
  return !lock || lock[RETRY_SAFE_PROPERTY] !== false;
}

function shouldStopMonitorBeforeConnect(
  transport = process.env.TTLOCK_BLUETOOTH_TRANSPORT,
) {
  // Native BlueZ can connect while discovery remains active. Avoiding a
  // StopDiscovery -> Device1.Connect transition removes an adapter race that
  // repeatedly cost the first command attempt on the test hardware.
  return transport !== 'bluez';
}

function getCommandRetryDelayMs(
  transport = process.env.TTLOCK_BLUETOOTH_TRANSPORT,
) {
  return transport === 'bluez'
    ? NATIVE_BLUEZ_COMMAND_RETRY_DELAY_MS
    : DEFAULT_COMMAND_RETRY_DELAY_MS;
}

function markLockAdvertisement(lock, timestamp = Date.now()) {
  if (lock) lock[LAST_ADVERTISEMENT_PROPERTY] = timestamp;
}

function markLockAndStoredAdvertisement(lock, storedLock, timestamp = Date.now()) {
  markLockAdvertisement(lock, timestamp);
  if (storedLock && storedLock !== lock) markLockAdvertisement(storedLock, timestamp);
}

function getLockAdvertisementAge(lock, now = Date.now()) {
  const timestamp = Number(lock?.[LAST_ADVERTISEMENT_PROPERTY]);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, now - timestamp);
}

async function waitForFreshLockAdvertisement(lock, {
  freshnessMs = DEFAULT_ADVERTISEMENT_FRESHNESS_MS,
  timeoutMs = DEFAULT_ADVERTISEMENT_WAIT_MS,
  pollMs = 50,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const age = getLockAdvertisementAge(lock, now());
    if (age <= freshnessMs) return age;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

async function refreshDbusDeviceCache(lock) {
  const device = lock?.device?.device;
  if (device && typeof device.refreshDevice === 'function') {
    return await device.refreshDevice();
  }
  const peripheral = device?.peripheral;
  const binding = peripheral?._noble?._bindings;
  const peripheralId = peripheral?.uuid || peripheral?.id;
  if (!binding || typeof binding.refreshDevice !== 'function' || !peripheralId) return false;
  return await binding.refreshDevice(peripheralId);
}

/**
 * Connect to a lock with an outer timeout that cannot be bypassed by a hung
 * Noble/SDK promise. Command operations set readData=false so the SDK skips
 * its full metadata refresh before sending the physical command.
 */
async function connectWithPolicy(lock, {
  readData = true,
  timeoutMs,
} = {}) {
  const effectiveTimeoutMs = timeoutMs ?? (
    readData ? DEFAULT_FULL_CONNECT_TIMEOUT_MS : DEFAULT_COMMAND_CONNECT_TIMEOUT_MS
  );
  const skipDataRead = !readData;
  let timer;
  if (lock) lock[RETRY_SAFE_PROPERTY] = true;

  try {
    return await Promise.race([
      Promise.resolve().then(() => lock.connect(skipDataRead)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LockConnectTimeoutError(effectiveTimeoutMs)),
          effectiveTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // A native BlueZ Connect error can leave TTLock.connecting set even though
    // Device1.Connect has already failed. Drain/reset every failed setup so the
    // manager's bounded retry performs a real second connection attempt.
    await cancelStaleLockConnection(lock);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_ADVERTISEMENT_FRESHNESS_MS,
  DEFAULT_ADVERTISEMENT_WAIT_MS,
  DEFAULT_WAKE_ADVERTISEMENT_WAIT_MS,
  DEFAULT_COMMAND_RETRY_DELAY_MS,
  NATIVE_BLUEZ_COMMAND_RETRY_DELAY_MS,
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  DEFAULT_HARD_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  LAST_ADVERTISEMENT_PROPERTY,
  RETRY_SAFE_PROPERTY,
  cancelStaleLockConnection,
  connectWithPolicy,
  getLockAdvertisementAge,
  getCommandRetryDelayMs,
  isConnectionRetrySafe,
  markLockAndStoredAdvertisement,
  markLockAdvertisement,
  refreshDbusDeviceCache,
  shouldStopMonitorBeforeConnect,
  waitForFreshLockAdvertisement,
};
