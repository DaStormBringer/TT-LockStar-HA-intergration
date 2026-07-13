'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADVERTISEMENT_PUBLISH_INTERVAL_MS,
  AdvertisedLockState,
  clearAdvertisementStates,
  getAdvertisementHistory,
  getAdvertisementState,
  observeLockAdvertisement,
} = require('../src/advertisementState');

const ADDRESS = 'DC:47:11:85:94:2F';

function createLock(isUnlock, hasEvents = false, batteryCapacity = 81, payload = undefined) {
  return {
    getAddress: () => ADDRESS.toLowerCase(),
    device: { isUnlock, hasEvents, batteryCapacity, device: payload },
  };
}

test.beforeEach(() => clearAdvertisementStates());

test('reports the advertisement unlock bit without treating it as confirmed state', () => {
  const result = observeLockAdvertisement(createLock(true), Date.UTC(2026, 6, 13, 12));

  assert.equal(result.changed, true);
  assert.equal(result.semanticChanged, true);
  assert.equal(result.payloadChanged, true);
  assert.equal(result.publish, true);
  assert.deepEqual(result.observation, {
    address: ADDRESS,
    state: AdvertisedLockState.UNLOCK_SIGNAL,
    isUnlock: true,
    hasEvents: false,
    battery: 81,
    manufacturerDataHex: null,
    manufacturerData: {},
    serviceData: {},
    payloadSignature: null,
    observedAt: '2026-07-13T12:00:00.000Z',
    observedAtMs: Date.UTC(2026, 6, 13, 12),
    source: 'ble_advertisement',
    confirmed: false,
  });
});

test('labels a false unlock bit as idle rather than locked', () => {
  const result = observeLockAdvertisement(createLock(false));

  assert.equal(result.observation.state, AdvertisedLockState.IDLE_NO_UNLOCK_SIGNAL);
  assert.equal(result.observation.isUnlock, false);
  assert.equal(result.observation.confirmed, false);
  assert.notEqual(result.observation.state, 'LOCKED');
});

test('refreshes observation time while rate-limiting unchanged publications', () => {
  const firstTime = 100000;
  const first = observeLockAdvertisement(createLock(false), firstTime);
  const repeated = observeLockAdvertisement(createLock(false), firstTime + 1000);
  const periodic = observeLockAdvertisement(
    createLock(false),
    firstTime + ADVERTISEMENT_PUBLISH_INTERVAL_MS + 1,
  );

  assert.equal(first.publish, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.publish, false);
  assert.equal(periodic.changed, false);
  assert.equal(periodic.publish, true);
  assert.equal(getAdvertisementState(ADDRESS).observedAtMs, periodic.observation.observedAtMs);
});

test('returns an explicit unknown diagnostic when no advertisement was decoded', () => {
  assert.deepEqual(getAdvertisementState(ADDRESS), {
    address: ADDRESS,
    state: AdvertisedLockState.UNKNOWN,
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
  });

  const missing = observeLockAdvertisement({ getAddress: () => ADDRESS });
  assert.equal(missing.changed, false);
  assert.equal(missing.semanticChanged, false);
  assert.equal(missing.payloadChanged, false);
  assert.equal(missing.publish, false);
});

test('creates a stable signature from normalized manufacturer and service data', () => {
  const payloadA = {
    manufacturerData: Buffer.from('c8030102', 'hex'),
    rawManufacturerData: { 968: '0102', 12: Buffer.from('aabb', 'hex') },
    serviceData: { 1910: '0304', abcd: Buffer.from('0506', 'hex') },
  };
  const payloadB = {
    manufacturerData: Uint8Array.from([0xc8, 0x03, 0x01, 0x02]),
    rawManufacturerData: { 12: 'aabb', 968: Buffer.from('0102', 'hex') },
    serviceData: { abcd: '0506', 1910: Buffer.from('0304', 'hex') },
  };

  const first = observeLockAdvertisement(createLock(false, false, 81, payloadA), 1000);
  const repeated = observeLockAdvertisement(createLock(false, false, 81, payloadB), 2000);

  assert.match(first.observation.payloadSignature, /^[0-9a-f]{16}$/);
  assert.equal(repeated.observation.payloadSignature, first.observation.payloadSignature);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.payloadChanged, false);
  assert.equal(first.observation.manufacturerDataHex, 'c8030102');
  assert.deepEqual(first.observation.manufacturerData, { 12: 'aabb', 968: '0102' });
  assert.deepEqual(first.observation.serviceData, { 1910: '0304', abcd: '0506' });
});

test('retains only unique payload observations in process-local history', () => {
  const firstPayload = { manufacturerData: Buffer.from('c80300', 'hex') };
  const secondPayload = { manufacturerData: Buffer.from('c80301', 'hex') };

  observeLockAdvertisement(createLock(false, false, 81, firstPayload), 1000);
  observeLockAdvertisement(createLock(false, false, 81, firstPayload), 2000);
  const changed = observeLockAdvertisement(createLock(false, false, 81, secondPayload), 3000);

  const history = getAdvertisementHistory(ADDRESS);
  assert.equal(history.length, 2);
  assert.notEqual(history[0].payloadSignature, history[1].payloadSignature);
  assert.equal(changed.payloadChanged, true);
  assert.equal(changed.semanticChanged, false);
  assert.equal(changed.publish, false);
  assert.deepEqual(getAdvertisementHistory('00:00:00:00:00:00'), []);
});
