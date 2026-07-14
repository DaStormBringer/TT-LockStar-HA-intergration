'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';

const manager = require('../src/manager');
const store = require('../src/store');

const ADDRESS = 'DC:47:11:85:94:2F';

test('lock and unlock never retry after an ambiguous command failure', async (t) => {
  const originalPairedLocks = manager.pairedLocks;
  const originalConnect = manager._connectLock;
  const originalDisconnect = manager.disconnectLock;
  const originalSetLockData = store.setLockData;
  t.after(() => {
    manager.pairedLocks = originalPairedLocks;
    manager._connectLock = originalConnect;
    manager.disconnectLock = originalDisconnect;
    store.setLockData = originalSetLockData;
  });

  store.setLockData = async () => {
    assert.fail('failed actuator commands must not persist a successful state');
  };

  for (const [methodName, sdkMethod] of [
    ['lockLock', 'lock'],
    ['unlockLock', 'unlock'],
  ]) {
    let connectCalls = 0;
    let commandCalls = 0;
    let disconnectCalls = 0;
    const lock = {
      getAddress: () => ADDRESS,
      isConnected: () => false,
      [sdkMethod]: async () => {
        commandCalls += 1;
        throw new Error('ambiguous notification timeout');
      },
    };

    manager.pairedLocks = new Map([[ADDRESS, lock]]);
    manager._connectLock = async () => {
      connectCalls += 1;
      return true;
    };
    manager.disconnectLock = async () => {
      disconnectCalls += 1;
      return true;
    };

    assert.equal(await manager[methodName](ADDRESS), false);
    assert.equal(connectCalls, 1);
    assert.equal(commandCalls, 1);
    assert.equal(disconnectCalls, 1);
  }
});

test('a failed actuator connection does not send or retry the command', async (t) => {
  const originalPairedLocks = manager.pairedLocks;
  const originalConnect = manager._connectLock;
  const originalDisconnect = manager.disconnectLock;
  t.after(() => {
    manager.pairedLocks = originalPairedLocks;
    manager._connectLock = originalConnect;
    manager.disconnectLock = originalDisconnect;
  });

  let connectCalls = 0;
  let commandCalls = 0;
  let disconnectCalls = 0;
  const lock = {
    getAddress: () => ADDRESS,
    lock: async () => {
      commandCalls += 1;
      return true;
    },
  };
  manager.pairedLocks = new Map([[ADDRESS, lock]]);
  manager._connectLock = async () => {
    connectCalls += 1;
    return false;
  };
  manager.disconnectLock = async () => {
    disconnectCalls += 1;
    return true;
  };

  assert.equal(await manager.lockLock(ADDRESS), false);
  assert.equal(connectCalls, 1);
  assert.equal(commandCalls, 0);
  assert.equal(disconnectCalls, 0);
});
