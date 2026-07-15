'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';
const { Manager, PRECONNECT_WAKE_WAIT_MS } = require('../src/manager');
const { markLockAdvertisement } = require('../src/connectionPolicy');

const ADDRESS = 'DC:47:11:85:94:2F';

test('manager prepares a read-only connection lease and expires it through disconnectLock', async () => {
  const manager = new Manager();
  let connected = false;
  let verificationReads = 0;
  const lock = {
    getAddress: () => ADDRESS,
    getLockTime: async () => { verificationReads += 1; },
    isConnected: () => connected,
  };
  let expiryCallback;
  manager.pairedLocks.set(ADDRESS, lock);
  manager._connectLock = async () => {
    connected = true;
    return true;
  };
  manager._waitForPreparedAdvertisement = async () => true;
  let keepaliveStarted = false;
  manager._startPreparedConnectionKeepalive = () => { keepaliveStarted = true; };
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
  assert.equal(verificationReads, 1);
  assert.equal(keepaliveStarted, true);
  await expiryCallback();
  assert.equal(disconnected, ADDRESS);
});

test('manager rejects a prepared lease when the command channel cannot answer a harmless read', async () => {
  const manager = new Manager();
  const lock = {
    getAddress: () => ADDRESS,
    getLockTime: async () => { throw new Error('no notification reply'); },
    isConnected: () => true,
  };
  manager.pairedLocks.set(ADDRESS, lock);
  let scheduled = false;
  manager.preparedConnections = {
    get: () => undefined,
    schedule: () => { scheduled = true; },
    clear: () => undefined,
  };
  let disconnected;
  manager.disconnectLock = async address => { disconnected = address; };

  const result = await manager.prepareLockConnection(ADDRESS, 15);

  assert.equal(result, false);
  assert.equal(scheduled, false);
  assert.equal(disconnected, ADDRESS);
});

test('preparation has a longer wake window than a physical command', async () => {
  const manager = new Manager();
  const lock = { getAddress: () => ADDRESS };
  assert.equal(PRECONNECT_WAKE_WAIT_MS, 60000);

  const missing = await manager._waitForPreparedAdvertisement(lock, { timeoutMs: 5 });
  assert.equal(missing, false);

  markLockAdvertisement(lock);
  const fresh = await manager._waitForPreparedAdvertisement(lock, { timeoutMs: 5 });
  assert.equal(fresh, true);
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
    getLockTime: async () => Date.now(),
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
  manager._waitForPreparedAdvertisement = async () => true;
  manager._startPreparedConnectionKeepalive = () => {};

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

test('prepared keepalive is bounded and stops before scheduling another read', async () => {
  const manager = new Manager();
  let reads = 0;
  let resolveFirstRead;
  const firstRead = new Promise(resolve => { resolveFirstRead = resolve; });
  const lock = {
    getAddress: () => ADDRESS,
    getLockTime: async () => {
      reads += 1;
      resolveFirstRead();
    },
    isConnected: () => true,
  };

  manager._startPreparedConnectionKeepalive(lock, 1);
  await firstRead;
  assert.equal(await manager._stopPreparedConnectionKeepalive(ADDRESS), true);
  const stoppedAt = reads;
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(stoppedAt, 1);
  assert.equal(reads, stoppedAt);
  assert.equal(manager.preparedConnectionKeepalives.has(ADDRESS), false);
});

test('a failed keepalive invalidates the lease and disconnects the prepared session', async () => {
  const manager = new Manager();
  let readAttempted;
  const attempted = new Promise(resolve => { readAttempted = resolve; });
  const lock = {
    getAddress: () => ADDRESS,
    getLockTime: async () => {
      readAttempted();
      throw new Error('notification timeout');
    },
    isConnected: () => true,
  };
  let cleared;
  manager.preparedConnections = {
    clear: address => { cleared = address; },
  };
  let disconnected;
  manager.disconnectLock = async address => { disconnected = address; };

  manager._startPreparedConnectionKeepalive(lock, 1);
  await attempted;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(cleared, ADDRESS);
  assert.equal(disconnected, ADDRESS);
  assert.equal(manager.preparedConnectionKeepalives.has(ADDRESS), false);
});

test('claim waits for an in-flight keepalive before handing the session to a command', async () => {
  const manager = new Manager();
  let releaseRead;
  let startedRead;
  const readStarted = new Promise(resolve => { startedRead = resolve; });
  const readPending = new Promise(resolve => { releaseRead = resolve; });
  const lock = {
    getAddress: () => ADDRESS,
    getLockTime: async () => {
      startedRead();
      await readPending;
    },
    isConnected: () => true,
  };
  let claimed = false;
  manager.preparedConnections = {
    get: () => ({ expiresAt: Date.now() + 10000 }),
    claim: () => { claimed = true; },
    clear: () => undefined,
  };

  manager._startPreparedConnectionKeepalive(lock, 1);
  await readStarted;
  let settled = false;
  const claim = manager._claimPreparedConnection(lock).then(result => {
    settled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  releaseRead();
  assert.equal(await claim, true);
  assert.equal(claimed, true);
  assert.equal(manager.preparedConnectionKeepalives.has(ADDRESS), false);
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
