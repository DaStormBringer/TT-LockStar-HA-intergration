'use strict';

const DEFAULT_HARD_CONNECT_TIMEOUT_MS = 55000;

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
  timeoutMs = DEFAULT_HARD_CONNECT_TIMEOUT_MS,
} = {}) {
  const skipDataRead = !readData;
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(() => lock.connect(skipDataRead)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LockConnectTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_HARD_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  connectWithPolicy,
};
