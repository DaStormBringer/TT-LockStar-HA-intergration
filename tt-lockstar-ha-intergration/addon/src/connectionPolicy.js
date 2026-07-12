'use strict';

const DEFAULT_FULL_CONNECT_TIMEOUT_MS = 55000;
const DEFAULT_COMMAND_CONNECT_TIMEOUT_MS = 12000;
const DEFAULT_HARD_CONNECT_TIMEOUT_MS = DEFAULT_FULL_CONNECT_TIMEOUT_MS;

class LockConnectTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Lock connection exceeded the ${timeoutMs}ms hard timeout`);
    this.name = 'LockConnectTimeoutError';
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
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  DEFAULT_HARD_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  connectWithPolicy,
};
