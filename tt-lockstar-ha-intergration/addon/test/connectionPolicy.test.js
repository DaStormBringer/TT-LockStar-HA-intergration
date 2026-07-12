'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LockConnectTimeoutError,
  connectWithPolicy,
} = require('../src/connectionPolicy');

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
