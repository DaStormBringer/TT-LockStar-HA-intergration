'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ADVERTISEMENT_PUBLISH_INTERVAL_MS,
  AdvertisedLockState,
  clearAdvertisementStates,
  getAdvertisementState,
  observeLockAdvertisement,
} = require('../src/advertisementState');

const ADDRESS = 'DC:47:11:85:94:2F';

function createLock(isUnlock, hasEvents = false, batteryCapacity = 81) {
  return {
    getAddress: () => ADDRESS.toLowerCase(),
    device: { isUnlock, hasEvents, batteryCapacity },
  };
}

test.beforeEach(() => clearAdvertisementStates());

test('reports the advertisement unlock bit without treating it as confirmed state', () => {
  const result = observeLockAdvertisement(createLock(true), Date.UTC(2026, 6, 13, 12));

  assert.equal(result.changed, true);
  assert.equal(result.publish, true);
  assert.deepEqual(result.observation, {
    address: ADDRESS,
    state: AdvertisedLockState.UNLOCK_SIGNAL,
    isUnlock: true,
    hasEvents: false,
    battery: 81,
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
    observedAt: null,
    observedAtMs: null,
    source: 'ble_advertisement',
    confirmed: false,
  });

  const missing = observeLockAdvertisement({ getAddress: () => ADDRESS });
  assert.equal(missing.changed, false);
  assert.equal(missing.publish, false);
});
