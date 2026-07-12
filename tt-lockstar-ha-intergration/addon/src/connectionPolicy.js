'use strict';

const DEFAULT_FULL_CONNECT_TIMEOUT_MS = 55000;
const DEFAULT_COMMAND_CONNECT_TIMEOUT_MS = 12000;
const DEFAULT_HARD_CONNECT_TIMEOUT_MS = DEFAULT_FULL_CONNECT_TIMEOUT_MS;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1500;

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
  const peripheral = resetConnectionState(lock);
  if (!peripheral) return;

  try {
    if (typeof peripheral.cancelConnect === 'function') peripheral.cancelConnect();
  } catch (_) {
    // Noble throws if the connection completed between the state check and cancel.
  }

  if (peripheral.state !== 'connected' || typeof peripheral.disconnectAsync !== 'function') return;

  let timer;
  try {
    await Promise.race([
      peripheral.disconnectAsync(),
      new Promise(resolve => {
        timer = setTimeout(resolve, cleanupTimeoutMs);
      }),
    ]);
  } catch (_) {
    // Cleanup is best effort; the scanner will replace the stale peripheral.
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    if (error instanceof LockConnectTimeoutError) {
      await cancelStaleLockConnection(lock);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  DEFAULT_HARD_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  cancelStaleLockConnection,
  connectWithPolicy,
};
