'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';

const {
  AudioManage,
  ConfigRemoteUnlock,
  FeatureValue,
  LockedStatus,
} = require('ttlock-sdk-js/dist/constant');
const manager = require('../src/manager');
const store = require('../src/store');

const ADDRESS = 'DC:47:11:85:94:2F';

test('new high-level manager commands use command-only SDK sessions', async (t) => {
  const originalPairedLocks = manager.pairedLocks;
  const originalConnect = manager._connectLock;
  const originalSetCredentialList = store.setCredentialList;
  const cacheWrites = [];
  t.after(() => {
    manager.pairedLocks = originalPairedLocks;
    manager._connectLock = originalConnect;
    store.setCredentialList = originalSetCredentialList;
  });

  const calls = [];
  const passage = { type: 1, weekOrDay: 0, month: 0, startHour: '0800', endHour: '1700' };
  const lock = {
    lockedStatus: LockedStatus.LOCKED,
    featureList: new Set([
      FeatureValue.PASSCODE,
      FeatureValue.IC,
      FeatureValue.FINGER_PRINT,
      FeatureValue.AUTO_LOCK,
      FeatureValue.CONFIG_GATEWAY_UNLOCK,
      FeatureValue.AUDIO_MANAGEMENT,
      FeatureValue.PASSAGE_MODE,
    ]),
    hasAutolock: () => true,
    hasLockSound: () => true,
    hasPassCode: () => true,
    hasICCard: () => true,
    hasFingerprint: () => true,
    getAutolockTime: async noCache => { calls.push(['getAutolockTime', noCache]); return 30; },
    setAutoLockTime: async value => { calls.push(['setAutoLockTime', value]); return true; },
    getLockSound: async noCache => { calls.push(['getLockSound', noCache]); return AudioManage.TURN_ON; },
    setLockSound: async value => { calls.push(['setLockSound', value]); return true; },
    getPassageMode: async () => { calls.push(['getPassageMode']); return [passage]; },
    setPassageMode: async value => { calls.push(['setPassageMode', value]); return true; },
    deletePassageMode: async value => { calls.push(['deletePassageMode', value]); return true; },
    clearPassageMode: async () => { calls.push(['clearPassageMode']); return true; },
    setRemoteUnlock: async value => {
      calls.push(['setRemoteUnlock', value]);
      return value === undefined ? ConfigRemoteUnlock.OP_CLOSE : value;
    },
    clearPassCodes: async () => { calls.push(['clearPassCodes']); return true; },
    clearICCards: async () => { calls.push(['clearICCards']); return true; },
    clearFingerprints: async () => { calls.push(['clearFingerprints']); return true; },
  };
  manager.pairedLocks = new Map([[ADDRESS, lock]]);
  manager._connectLock = async (candidate, readData) => {
    assert.equal(candidate, lock);
    assert.equal(readData, false);
    return true;
  };
  store.setCredentialList = async (address, kind, values) => cacheWrites.push([address, kind, values]);

  assert.equal(await manager.getAutoLock(ADDRESS), 30);
  assert.equal(await manager.setAutoLock(ADDRESS, 45), true);
  assert.equal(await manager.getAudio(ADDRESS), AudioManage.TURN_ON);
  assert.equal(await manager.setAudio(ADDRESS, false), true);
  assert.deepEqual(await manager.getPassageMode(ADDRESS), [passage]);
  assert.equal(await manager.setPassageMode(ADDRESS, passage), true);
  assert.equal(await manager.deletePassageMode(ADDRESS, passage), true);
  assert.equal(await manager.clearPassageMode(ADDRESS), true);
  assert.deepEqual(await manager.getRemoteUnlock(ADDRESS), { value: 0, enabled: false });
  assert.deepEqual(await manager.setRemoteUnlock(ADDRESS, true), { value: 1, enabled: true });
  const featureResult = await manager.getLockFeatures(ADDRESS);
  assert.equal(featureResult.source, 'saved-or-process-cache');
  assert.deepEqual(featureResult.supports, {
    autoLock: true,
    audio: true,
    passcode: true,
    card: true,
    fingerprint: true,
    passageMode: true,
    remoteUnlockConfiguration: true,
  });
  assert.equal(featureResult.features.some(item => item.name === 'PASSCODE'), true);
  assert.equal(await manager.clearPasscodes(ADDRESS), true);
  assert.equal(await manager.clearCards(ADDRESS), true);
  assert.equal(await manager.clearFingers(ADDRESS), true);

  assert.deepEqual(manager.getLockStatusEvidence(ADDRESS), {
    address: ADDRESS,
    status: LockedStatus.LOCKED,
    statusName: 'LOCKED',
    doorState: undefined,
    advertisement: {
      address: ADDRESS,
      state: 'UNKNOWN',
      isUnlock: null,
      hasEvents: null,
      battery: null,
      manufacturerDataHex: null,
      manufacturerData: {},
      serviceData: {},
      payloadSignature: null,
      observedAt: null,
      observedAtMs: null,
      source: 'ble_advertisement',
      confirmed: false,
    },
    advertisementHistory: [],
    liveCommandSent: false,
    source: 'last-confirmed-command-or-operation-log',
    readOnly: true,
  });
  assert.deepEqual(cacheWrites, [
    [ADDRESS, 'passcodes', []],
    [ADDRESS, 'cards', []],
    [ADDRESS, 'fingers', []],
  ]);
  assert.equal(calls.some(item => item[0] === 'setLockSound' && item[1] === AudioManage.TURN_OFF), true);
});

test('loads and persists hardware features before feature-gated commands', async (t) => {
  const originalPairedLocks = manager.pairedLocks;
  const originalConnect = manager._connectLock;
  const originalClient = manager.client;
  const originalSetLockData = store.setLockData;
  t.after(() => {
    manager.pairedLocks = originalPairedLocks;
    manager._connectLock = originalConnect;
    manager.client = originalClient;
    store.setLockData = originalSetLockData;
  });

  const lock = {
    getAddress: () => ADDRESS,
    hasAutolock: () => lock.featureList.has(FeatureValue.AUTO_LOCK),
    hasLockSound: () => lock.featureList.has(FeatureValue.AUDIO_MANAGEMENT),
    hasPassCode: () => lock.featureList.has(FeatureValue.PASSCODE),
    hasICCard: () => lock.featureList.has(FeatureValue.IC),
    hasFingerprint: () => lock.featureList.has(FeatureValue.FINGER_PRINT),
  };
  const saved = [{ address: ADDRESS, featureList: [FeatureValue.PASSCODE, FeatureValue.AUTO_LOCK] }];
  let persisted;
  manager.pairedLocks = new Map([[ADDRESS, lock]]);
  manager.client = { getLockData: () => saved };
  manager._connectLock = async (candidate, readData) => {
    assert.equal(candidate, lock);
    assert.equal(readData, true);
    lock.featureList = new Set([FeatureValue.PASSCODE, FeatureValue.AUTO_LOCK]);
    return true;
  };
  store.setLockData = async value => { persisted = value; };

  const result = await manager.getLockFeatures(ADDRESS);

  assert.equal(result.source, 'live-read-only-discovery');
  assert.equal(result.supports.passcode, true);
  assert.equal(result.supports.autoLock, true);
  assert.equal(result.supports.card, false);
  assert.deepEqual(persisted, saved);
});
