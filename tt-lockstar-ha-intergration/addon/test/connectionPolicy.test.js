'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_ADVERTISEMENT_FRESHNESS_MS,
  DEFAULT_ADVERTISEMENT_WAIT_MS,
  DEFAULT_WAKE_ADVERTISEMENT_WAIT_MS,
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  LAST_ADVERTISEMENT_PROPERTY,
  RETRY_SAFE_PROPERTY,
  cancelStaleLockConnection,
  connectWithPolicy,
  getLockAdvertisementAge,
  isConnectionRetrySafe,
  markLockAndStoredAdvertisement,
  markLockAdvertisement,
  refreshDbusDeviceCache,
  waitForFreshLockAdvertisement,
} = require('../src/connectionPolicy');

test('uses a short command timeout without shortening metadata refreshes', () => {
  assert.equal(DEFAULT_ADVERTISEMENT_FRESHNESS_MS, 10000);
  assert.equal(DEFAULT_ADVERTISEMENT_WAIT_MS, 6000);
  assert.equal(DEFAULT_WAKE_ADVERTISEMENT_WAIT_MS, 15000);
  assert.equal(DEFAULT_COMMAND_CONNECT_TIMEOUT_MS, 12000);
  assert.equal(DEFAULT_CLEANUP_TIMEOUT_MS, 1500);
  assert.equal(DEFAULT_FULL_CONNECT_TIMEOUT_MS, 55000);
  assert.ok(DEFAULT_COMMAND_CONNECT_TIMEOUT_MS < DEFAULT_FULL_CONNECT_TIMEOUT_MS);
});

test('marks and measures the newest lock advertisement', () => {
  const lock = {};
  markLockAdvertisement(lock, 1000);

  assert.equal(lock[LAST_ADVERTISEMENT_PROPERTY], 1000);
  assert.equal(getLockAdvertisementAge(lock, 1250), 250);
  assert.equal(getLockAdvertisementAge({}, 1250), Infinity);
});

test('copies a live SDK update timestamp to the stored command lock', () => {
  const discoveredLock = {};
  const storedLock = {};
  markLockAndStoredAdvertisement(discoveredLock, storedLock, 2500);

  assert.equal(discoveredLock[LAST_ADVERTISEMENT_PROPERTY], 2500);
  assert.equal(storedLock[LAST_ADVERTISEMENT_PROPERTY], 2500);
});

test('waits for a fresh advertisement before connecting', async () => {
  const lock = {};
  let nowMs = 1000;
  let sleeps = 0;
  const age = await waitForFreshLockAdvertisement(lock, {
    freshnessMs: 100,
    timeoutMs: 500,
    pollMs: 50,
    now: () => nowMs,
    sleep: async ms => {
      sleeps += 1;
      nowMs += ms;
      if (sleeps === 2) markLockAdvertisement(lock, nowMs);
    },
  });

  assert.equal(age, 0);
  assert.equal(sleeps, 2);
});

test('fails closed when no fresh advertisement arrives', async () => {
  const lock = {};
  let nowMs = 1000;
  const result = await waitForFreshLockAdvertisement(lock, {
    freshnessMs: 100,
    timeoutMs: 120,
    pollMs: 50,
    now: () => nowMs,
    sleep: async ms => { nowMs += ms; },
  });

  assert.equal(result, false);
  assert.equal(nowMs, 1120);
});

test('refreshes the target through the selected Noble D-Bus binding', async () => {
  const calls = [];
  const lock = {
    device: {
      device: {
        peripheral: {
          uuid: 'lock-id',
          _noble: {
            _bindings: {
              refreshDevice: async id => {
                calls.push(id);
                return true;
              },
            },
          },
        },
      },
    },
  };

  assert.equal(await refreshDbusDeviceCache(lock), true);
  assert.deepEqual(calls, ['lock-id']);
  assert.equal(await refreshDbusDeviceCache({}), false);
});

test('refreshes the target through the native BlueZ device adapter', async () => {
  let refreshCalls = 0;
  const lock = {
    device: {
      device: {
        refreshDevice: async () => {
          refreshCalls += 1;
          return true;
        },
      },
    },
  };

  assert.equal(await refreshDbusDeviceCache(lock), true);
  assert.equal(refreshCalls, 1);
});

test('uses a command-only SDK connection when metadata is not required', async () => {
  const calls = [];
  const lock = {
    connect: async skipDataRead => {
      calls.push(skipDataRead);
      return true;
    },
  };

  assert.equal(await connectWithPolicy(lock, { readData: false, timeoutMs: 100 }), true);
  assert.deepEqual(calls, [true]);
});

test('retains the full-data SDK connection for discovery and settings reads', async () => {
  const calls = [];
  const lock = {
    connect: async skipDataRead => {
      calls.push(skipDataRead);
      return true;
    },
  };

  assert.equal(await connectWithPolicy(lock, { readData: true, timeoutMs: 100 }), true);
  assert.deepEqual(calls, [false]);
});

test('rejects a hung SDK connection at the hard timeout', async () => {
  let cancelCalls = 0;
  let disconnectCalls = 0;
  let resetBusyCalls = 0;
  const peripheral = {
    state: 'connected',
    cancelConnect: () => { cancelCalls += 1; },
    disconnectAsync: async () => {
      disconnectCalls += 1;
      peripheral.state = 'disconnected';
    },
  };
  const nobleDevice = {
    connecting: true,
    connected: true,
    busy: true,
    services: new Map([['1910', {}]]),
    peripheral,
    resetBusy: () => { resetBusyCalls += 1; },
  };
  const bluetoothDevice = {
    connected: true,
    disconnectedDuringSetup: false,
    waitingForResponse: true,
    responses: [{}],
    device: nobleDevice,
  };
  const lock = {
    connecting: true,
    connected: true,
    skipDataRead: true,
    device: bluetoothDevice,
    connect: () => new Promise(() => {}),
  };

  await assert.rejects(
    connectWithPolicy(lock, { readData: false, timeoutMs: 10 }),
    LockConnectTimeoutError,
  );

  assert.equal(cancelCalls, 0);
  assert.equal(disconnectCalls, 1);
  assert.equal(resetBusyCalls, 1);
  assert.equal(lock.connecting, false);
  assert.equal(lock.connected, false);
  assert.equal(lock.skipDataRead, false);
  assert.equal(bluetoothDevice.connected, false);
  assert.equal(bluetoothDevice.disconnectedDuringSetup, true);
  assert.equal(bluetoothDevice.waitingForResponse, false);
  assert.deepEqual(bluetoothDevice.responses, []);
  assert.equal(nobleDevice.connecting, false);
  assert.equal(nobleDevice.connected, false);
  assert.equal(nobleDevice.services.size, 0);
  assert.equal(lock[RETRY_SAFE_PROPERTY], true);
  assert.equal(isConnectionRetrySafe(lock), true);
});

test('clears a native BlueZ setup error before the manager retries', async () => {
  let cancelCalls = 0;
  const peripheral = {
    state: 'error',
    cancelConnect: () => { cancelCalls += 1; },
  };
  const nativeDevice = {
    connecting: true,
    connected: false,
    services: new Map([['1910', {}]]),
    peripheral,
    resetBusy: () => {},
  };
  const lock = {
    connecting: true,
    connected: false,
    skipDataRead: true,
    device: {
      connected: false,
      device: nativeDevice,
    },
    connect: async () => { throw new Error('le-connection-abort-by-local'); },
  };

  await assert.rejects(
    connectWithPolicy(lock, { readData: false, timeoutMs: 100 }),
    /le-connection-abort-by-local/,
  );

  assert.equal(cancelCalls, 0);
  assert.equal(lock.connecting, false);
  assert.equal(lock.skipDataRead, false);
  assert.equal(nativeDevice.connecting, false);
  assert.equal(nativeDevice.services.size, 0);
  assert.equal(isConnectionRetrySafe(lock), true);
});

test('waits for a cancelled HCI connection to drain before allowing a retry', async () => {
  let cancelCalls = 0;
  let disconnectCalls = 0;
  const binding = { _pendingConnectionUuid: 'lock-id' };
  const peripheral = {
    uuid: 'lock-id',
    state: 'connecting',
    _noble: { _bindings: binding },
    cancelConnect: () => {
      cancelCalls += 1;
      setTimeout(() => {
        peripheral.state = 'error';
        binding._pendingConnectionUuid = null;
      }, 5);
    },
    disconnectAsync: async () => { disconnectCalls += 1; },
  };
  const lock = {
    device: {
      device: {
        peripheral,
      },
    },
  };

  assert.equal(await cancelStaleLockConnection(lock, 50), true);

  assert.equal(cancelCalls, 1);
  assert.equal(disconnectCalls, 0);
  assert.equal(isConnectionRetrySafe(lock), true);
});

test('suppresses a retry when Noble never drains its pending connection', async () => {
  const lock = {
    device: {
      device: {
        peripheral: {
          uuid: 'lock-id',
          state: 'connecting',
          _noble: { _bindings: { _pendingConnectionUuid: 'lock-id' } },
          cancelConnect: () => {},
        },
      },
    },
  };

  assert.equal(await cancelStaleLockConnection(lock, 10), false);
  assert.equal(isConnectionRetrySafe(lock), false);
});
