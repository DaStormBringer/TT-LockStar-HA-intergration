'use strict';

const ADVERTISEMENT_PUBLISH_INTERVAL_MS = 30000;
const AdvertisedLockState = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  UNLOCK_SIGNAL: 'UNLOCK_SIGNAL',
  IDLE_NO_UNLOCK_SIGNAL: 'IDLE_NO_UNLOCK_SIGNAL',
});

const observations = new Map();
const lastPublishedAt = new Map();

function normalizeAddress(address) {
  return typeof address === 'string' ? address.toUpperCase() : address;
}

function unknownObservation(address) {
  return {
    address: normalizeAddress(address),
    state: AdvertisedLockState.UNKNOWN,
    isUnlock: null,
    hasEvents: null,
    battery: null,
    observedAt: null,
    observedAtMs: null,
    source: 'ble_advertisement',
    confirmed: false,
  };
}

function cloneObservation(observation) {
  return { ...observation };
}

function getAdvertisementState(address) {
  const normalized = normalizeAddress(address);
  const observation = observations.get(normalized);
  return observation
    ? cloneObservation(observation)
    : unknownObservation(normalized);
}

function observeLockAdvertisement(lock, now = Date.now()) {
  const address = normalizeAddress(lock?.getAddress?.());
  const isUnlock = lock?.device?.isUnlock;
  if (!address || typeof isUnlock !== 'boolean') {
    return {
      observation: address ? getAdvertisementState(address) : null,
      changed: false,
      publish: false,
    };
  }

  const previous = observations.get(address);
  const hasEvents = typeof lock.device.hasEvents === 'boolean'
    ? lock.device.hasEvents
    : null;
  const battery = Number.isFinite(lock.device.batteryCapacity)
    ? lock.device.batteryCapacity
    : null;
  const observation = {
    address,
    state: isUnlock
      ? AdvertisedLockState.UNLOCK_SIGNAL
      : AdvertisedLockState.IDLE_NO_UNLOCK_SIGNAL,
    isUnlock,
    hasEvents,
    battery,
    observedAt: new Date(now).toISOString(),
    observedAtMs: now,
    source: 'ble_advertisement',
    confirmed: false,
  };
  const changed = !previous
    || previous.isUnlock !== observation.isUnlock
    || previous.hasEvents !== observation.hasEvents
    || previous.battery !== observation.battery;
  const previousPublishedAt = lastPublishedAt.get(address);
  const publish = changed
    || !Number.isFinite(previousPublishedAt)
    || now - previousPublishedAt >= ADVERTISEMENT_PUBLISH_INTERVAL_MS;

  observations.set(address, observation);
  if (publish) lastPublishedAt.set(address, now);
  return {
    observation: cloneObservation(observation),
    changed,
    publish,
  };
}

function clearAdvertisementStates() {
  observations.clear();
  lastPublishedAt.clear();
}

module.exports = {
  ADVERTISEMENT_PUBLISH_INTERVAL_MS,
  AdvertisedLockState,
  clearAdvertisementStates,
  getAdvertisementState,
  observeLockAdvertisement,
};
