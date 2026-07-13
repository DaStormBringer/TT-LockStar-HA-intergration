'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';
const { Manager } = require('../src/manager');

const ADDRESS = 'DC:47:11:85:94:2F';

test('manager prepares a read-only connection lease and expires it through disconnectLock', async () => {
  const manager = new Manager();
  let connected = false;
  const lock = {
    getAddress: () => ADDRESS,
    isConnected: () => connected,
  };
  let expiryCallback;
  manager.pairedLocks.set(ADDRESS, lock);
  manager._connectLock = async () => {
    connected = true;
    return true;
  };
  manager.preparedConnections = {
    get: () => undefined,
    schedule: (address, holdMs, callback) => {
      assert.equal(address, ADDRESS);
      assert.equal(holdMs, 15000);
      expiryCallback = callback;
      return { expiresAt: Date.parse('2026-07-13T12:00:00.000Z') };
    },
  };
  let disconnected;
  manager.disconnectLock = async address => { disconnected = address; };

  const result = await manager.prepareLockConnection(ADDRESS, 15);

  assert.deepEqual(result, {
    address: ADDRESS,
    connected: true,
    holdSeconds: 15,
    expiresAt: '2026-07-13T12:00:00.000Z',
    readOnly: true,
  });
  await expiryCallback();
  assert.equal(disconnected, ADDRESS);
});

test('manager claims a prepared connection before entering the mutex wait', async () => {
  const manager = new Manager();
  let claimed = false;
  const lock = {
    getAddress: () => ADDRESS,
    isConnected: () => true,
  };
  manager.preparedConnections = {
    get: () => ({ expiresAt: Date.now() + 10000 }),
    claim: address => {
      assert.equal(address, ADDRESS);
      claimed = true;
    },
  };
  manager.lockMutexes.set(ADDRESS, { promise: new Promise(() => {}), resolve: () => {} });

  const result = await manager._connectLock(lock, false);

  assert.equal(result, true);
  assert.equal(claimed, true);
});

test('connection preparation waits rather than hijacking an active command session', async () => {
  const manager = new Manager();
  let connected = true;
  let releaseActive;
  let connectCalls = 0;
  let scheduled = false;
  const activePromise = new Promise(resolve => { releaseActive = resolve; });
  const lock = {
    getAddress: () => ADDRESS,
    isConnected: () => connected,
  };
  manager.pairedLocks.set(ADDRESS, lock);
  manager.lockMutexes.set(ADDRESS, { promise: activePromise, resolve: releaseActive });
  manager.preparedConnections = {
    get: () => undefined,
    schedule: () => {
      scheduled = true;
      return { expiresAt: Date.parse('2026-07-13T12:00:00.000Z') };
    },
  };
  manager._connectLock = async () => {
    connectCalls += 1;
    connected = true;
    return true;
  };

  const pending = manager.prepareLockConnection(ADDRESS, 15);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled, false);
  assert.equal(connectCalls, 0);

  connected = false;
  manager.lockMutexes.delete(ADDRESS);
  releaseActive();
  const result = await pending;

  assert.equal(result.connected, true);
  assert.equal(connectCalls, 1);
  assert.equal(scheduled, true);
});

test('an unexpected prepared-session disconnect releases its mutex and resumes monitoring', async () => {
  const manager = new Manager();
  let resolved = false;
  let monitorStarts = 0;
  manager.interacting = true;
  manager.preparedConnections = { clear: () => ({ expiresAt: Date.now() + 10000 }) };
  manager.lockMutexes.set(ADDRESS, { promise: Promise.resolve(), resolve: () => { resolved = true; } });
  manager.client = { startMonitor: () => { monitorStarts += 1; } };

  await manager._onLockDisconnected({ getAddress: () => ADDRESS });

  assert.equal(manager.interacting, false);
  assert.equal(manager.lockMutexes.has(ADDRESS), false);
  assert.equal(resolved, true);
  assert.equal(monitorStarts, 1);
});
