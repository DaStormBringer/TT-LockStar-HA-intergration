'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  cancelStaleLockConnection,
  connectWithPolicy,
} = require('../src/connectionPolicy');

test('uses a short command timeout without shortening metadata refreshes', () => {
  assert.equal(DEFAULT_COMMAND_CONNECT_TIMEOUT_MS, 12000);
  assert.equal(DEFAULT_CLEANUP_TIMEOUT_MS, 1500);
  assert.equal(DEFAULT_FULL_CONNECT_TIMEOUT_MS, 55000);
  assert.ok(DEFAULT_COMMAND_CONNECT_TIMEOUT_MS < DEFAULT_FULL_CONNECT_TIMEOUT_MS);
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
    disconnectAsync: async () => { disconnectCalls += 1; },
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

  assert.equal(cancelCalls, 1);
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
});

test('cancels a connecting peripheral without trying to disconnect it', async () => {
  let cancelCalls = 0;
  let disconnectCalls = 0;
  const lock = {
    device: {
      device: {
        peripheral: {
          state: 'connecting',
          cancelConnect: () => { cancelCalls += 1; },
          disconnectAsync: async () => { disconnectCalls += 1; },
        },
      },
    },
  };

  await cancelStaleLockConnection(lock, 10);

  assert.equal(cancelCalls, 1);
  assert.equal(disconnectCalls, 0);
});
