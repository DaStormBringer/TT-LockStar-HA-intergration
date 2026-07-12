'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_COMMAND_CONNECT_TIMEOUT_MS,
  DEFAULT_FULL_CONNECT_TIMEOUT_MS,
  LockConnectTimeoutError,
  connectWithPolicy,
} = require('../src/connectionPolicy');

test('uses a short command timeout without shortening metadata refreshes', () => {
  assert.equal(DEFAULT_COMMAND_CONNECT_TIMEOUT_MS, 12000);
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
  const lock = {
    connect: () => new Promise(() => {}),
  };

  await assert.rejects(
    connectWithPolicy(lock, { readData: false, timeoutMs: 10 }),
    LockConnectTimeoutError,
  );
});
