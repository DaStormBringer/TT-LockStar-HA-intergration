'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const test = require('node:test');

const HomeAssistant = require('../src/ha');
const { MQTT_PREWARM_HOLD_SECONDS } = require('../src/ha');

const ADDRESS = 'DC:47:11:85:94:2F';
const LOCK_ID = 'dc471185942f';

function fakeManager(overrides = {}) {
  const manager = new EventEmitter();
  Object.assign(manager, {
    prepareLockConnection: async () => undefined,
    disconnectLock: async () => undefined,
    lockLock: async () => undefined,
    unlockLock: async () => undefined,
    getLockTime: async () => undefined,
    syncLockTime: async () => undefined,
  }, overrides);
  return manager;
}

function fakeLock() {
  return {
    getAddress: () => ADDRESS,
    getName: () => 'M302',
    getManufacturer: () => 'TTLock',
    getModel: () => 'M302',
    getFirmware: () => '6.4.43.24052101',
  };
}

test('subscribes to the read-only pre-warm command topic', async () => {
  const subscriptions = [];
  const client = {
    on: () => undefined,
    subscribe: async topic => { subscriptions.push(topic); },
  };
  const ha = new HomeAssistant({
    manager: fakeManager(),
    mqttUrl: 'mqtt://test:1883',
    mqttUser: 'test-user',
    mqttPass: 'test-pass',
    mqttConnectAsync: async () => client,
  });

  await ha.connect();

  assert.equal(ha.connected, true);
  assert.ok(subscriptions.includes('ttlock/+/prewarm/set'));
  assert.ok(subscriptions.includes('ttlock/+/prepare/set'));
});

test('publishes Home Assistant discovery for the pre-warm button', async () => {
  const published = [];
  const ha = new HomeAssistant({ manager: fakeManager() });
  ha.connected = true;
  ha.client = {
    publish: async (topic, payload, options) => {
      published.push({ topic, payload: JSON.parse(payload), options });
    },
  };

  await ha.configureLock(fakeLock());

  const discovery = published.find(item => item.topic === `homeassistant/button/${LOCK_ID}/prepare/config`);
  assert.ok(discovery);
  assert.equal(discovery.payload.unique_id, `ttlock_${LOCK_ID}_prepare`);
  assert.equal(discovery.payload.name, 'Prewarm M302 Connection');
  assert.equal(discovery.payload.command_topic, `ttlock/${LOCK_ID}/prewarm/set`);
  assert.equal(discovery.payload.payload_press, 'PRESS');
  assert.equal(discovery.payload.icon, 'mdi:bluetooth-connect');
  assert.deepEqual(discovery.options, { retain: true });
});

test('pre-warm command creates one bounded lease without an actuator or early disconnect', async () => {
  const calls = [];
  const manager = fakeManager({
    prepareLockConnection: async (address, holdSeconds) => {
      calls.push(['prepareLockConnection', address, holdSeconds]);
      return { connected: true, holdSeconds, readOnly: true };
    },
    disconnectLock: async address => { calls.push(['disconnectLock', address]); },
    lockLock: async address => { calls.push(['lockLock', address]); },
    unlockLock: async address => { calls.push(['unlockLock', address]); },
  });
  const ha = new HomeAssistant({ manager });

  await ha._onMQTTMessage(`ttlock/${LOCK_ID}/prewarm/set`, Buffer.from('PRESS'));

  assert.deepEqual(calls, [[
    'prepareLockConnection',
    ADDRESS,
    MQTT_PREWARM_HOLD_SECONDS,
  ]]);
  assert.equal(MQTT_PREWARM_HOLD_SECONDS, 15);
});

test('legacy prepare topic remains a pre-warm compatibility alias', async () => {
  const calls = [];
  const ha = new HomeAssistant({
    manager: fakeManager({
      prepareLockConnection: async (address, holdSeconds) => calls.push([address, holdSeconds]),
    }),
  });

  await ha._onMQTTMessage(`ttlock/${LOCK_ID}/prepare/set`, Buffer.from('PRESS'));

  assert.deepEqual(calls, [[ADDRESS, MQTT_PREWARM_HOLD_SECONDS]]);
});

test('pre-warm ignores any payload other than an exact button press', async () => {
  let calls = 0;
  const ha = new HomeAssistant({
    manager: fakeManager({
      prepareLockConnection: async () => { calls += 1; },
    }),
  });

  await ha._onMQTTMessage(`ttlock/${LOCK_ID}/prepare/set`, Buffer.from('LOCK'));

  assert.equal(calls, 0);
});
