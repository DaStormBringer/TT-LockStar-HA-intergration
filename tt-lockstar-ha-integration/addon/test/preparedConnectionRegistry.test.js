'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const PreparedConnectionRegistry = require('../src/preparedConnectionRegistry');

test('prepared connection can be claimed without running its expiry callback', async () => {
  const timers = [];
  const cleared = [];
  const registry = new PreparedConnectionRegistry({
    now: () => 1000,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: timer => cleared.push(timer),
  });
  let expired = false;

  assert.deepEqual(registry.schedule('lock', 15000, async () => { expired = true; }), { expiresAt: 16000 });
  assert.equal(timers[0].unrefCalled, true);
  assert.deepEqual(registry.get('lock'), { expiresAt: 16000 });
  assert.deepEqual(registry.claim('lock'), { expiresAt: 16000 });
  assert.equal(registry.get('lock'), undefined);
  assert.deepEqual(cleared, [timers[0]]);

  await timers[0].callback();
  assert.equal(expired, false);
});

test('prepared connection expiry removes the lease before disconnecting', async () => {
  let callback;
  const registry = new PreparedConnectionRegistry({
    setTimeoutFn: fn => {
      callback = fn;
      return { unref() {} };
    },
    clearTimeoutFn: () => {},
  });
  let absentDuringExpiry = false;
  registry.schedule('lock', 5000, async () => {
    absentDuringExpiry = registry.get('lock') === undefined;
  });

  callback();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(absentDuringExpiry, true);
  assert.equal(registry.get('lock'), undefined);
});
