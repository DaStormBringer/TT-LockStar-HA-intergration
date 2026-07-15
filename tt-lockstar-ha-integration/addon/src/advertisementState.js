'use strict';

const { createHash } = require('node:crypto');

const ADVERTISEMENT_PUBLISH_INTERVAL_MS = 30000;
const ADVERTISEMENT_HISTORY_LIMIT = 50;
const AdvertisedLockState = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  UNLOCK_SIGNAL: 'UNLOCK_SIGNAL',
  IDLE_NO_UNLOCK_SIGNAL: 'IDLE_NO_UNLOCK_SIGNAL',
});

const observations = new Map();
const lastPublishedAt = new Map();
const observationHistory = new Map();

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
    manufacturerDataHex: null,
    manufacturerData: {},
    serviceData: {},
    payloadSignature: null,
    observedAt: null,
    observedAtMs: null,
    source: 'ble_advertisement',
    confirmed: false,
  };
}

function cloneObservation(observation) {
  return {
    ...observation,
    manufacturerData: { ...observation.manufacturerData },
    serviceData: { ...observation.serviceData },
  };
}

function valueToHex(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer || value, value.byteOffset || 0, value.byteLength).toString('hex');
  }
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return normalized.length > 0 && normalized.length % 2 === 0 ? normalized : null;
}

function normalizeHexMap(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, raw]) => [String(key), valueToHex(raw)])
      .filter(([, hex]) => hex !== null),
  );
}

function extractAdvertisementPayload(lock) {
  const transportDevice = lock?.device?.device;
  const manufacturerDataHex = valueToHex(transportDevice?.manufacturerData);
  const manufacturerData = normalizeHexMap(transportDevice?.rawManufacturerData);
  const serviceData = normalizeHexMap(transportDevice?.serviceData);
  const hasPayload = manufacturerDataHex !== null
    || Object.keys(manufacturerData).length > 0
    || Object.keys(serviceData).length > 0;
  const payloadSignature = hasPayload
    ? createHash('sha256').update(JSON.stringify({
      manufacturerDataHex,
      manufacturerData,
      serviceData,
    })).digest('hex').slice(0, 16)
    : null;
  return {
    manufacturerDataHex,
    manufacturerData,
    serviceData,
    payloadSignature,
  };
}

function recordObservationHistory(address, observation) {
  const history = observationHistory.get(address) || [];
  const previous = history.at(-1);
  if (previous
    && previous.payloadSignature === observation.payloadSignature
    && previous.isUnlock === observation.isUnlock
    && previous.hasEvents === observation.hasEvents
    && previous.battery === observation.battery) {
    return;
  }
  history.push(cloneObservation(observation));
  if (history.length > ADVERTISEMENT_HISTORY_LIMIT) history.shift();
  observationHistory.set(address, history);
}

function getAdvertisementState(address) {
  const normalized = normalizeAddress(address);
  const observation = observations.get(normalized);
  return observation
    ? cloneObservation(observation)
    : unknownObservation(normalized);
}

function getAdvertisementHistory(address, limit = ADVERTISEMENT_HISTORY_LIMIT) {
  const normalized = normalizeAddress(address);
  const history = observationHistory.get(normalized) || [];
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, ADVERTISEMENT_HISTORY_LIMIT)
    : ADVERTISEMENT_HISTORY_LIMIT;
  return history.slice(-boundedLimit).map(cloneObservation);
}

function observeLockAdvertisement(lock, now = Date.now()) {
  const address = normalizeAddress(lock?.getAddress?.());
  const isUnlock = lock?.device?.isUnlock;
  if (!address || typeof isUnlock !== 'boolean') {
    return {
      observation: address ? getAdvertisementState(address) : null,
      changed: false,
      semanticChanged: false,
      payloadChanged: false,
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
  const payload = extractAdvertisementPayload(lock);
  const observation = {
    address,
    state: isUnlock
      ? AdvertisedLockState.UNLOCK_SIGNAL
      : AdvertisedLockState.IDLE_NO_UNLOCK_SIGNAL,
    isUnlock,
    hasEvents,
    battery,
    ...payload,
    observedAt: new Date(now).toISOString(),
    observedAtMs: now,
    source: 'ble_advertisement',
    confirmed: false,
  };
  const semanticChanged = !previous
    || previous.isUnlock !== observation.isUnlock
    || previous.hasEvents !== observation.hasEvents
    || previous.battery !== observation.battery;
  const payloadChanged = !previous
    || previous.payloadSignature !== observation.payloadSignature;
  const changed = semanticChanged || payloadChanged;
  const previousPublishedAt = lastPublishedAt.get(address);
  const publish = semanticChanged
    || !Number.isFinite(previousPublishedAt)
    || now - previousPublishedAt >= ADVERTISEMENT_PUBLISH_INTERVAL_MS;

  observations.set(address, observation);
  recordObservationHistory(address, observation);
  if (publish) lastPublishedAt.set(address, now);
  return {
    observation: cloneObservation(observation),
    changed,
    semanticChanged,
    payloadChanged,
    publish,
  };
}

function clearAdvertisementStates() {
  observations.clear();
  lastPublishedAt.clear();
  observationHistory.clear();
}

module.exports = {
  ADVERTISEMENT_PUBLISH_INTERVAL_MS,
  ADVERTISEMENT_HISTORY_LIMIT,
  AdvertisedLockState,
  clearAdvertisementStates,
  extractAdvertisementPayload,
  getAdvertisementHistory,
  getAdvertisementState,
  observeLockAdvertisement,
};
