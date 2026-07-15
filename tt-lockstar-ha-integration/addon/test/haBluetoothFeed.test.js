'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  HomeAssistantBluetoothFeed,
  normalizeHomeAssistantAdvertisement,
} = require('../src/haBluetoothFeed');

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.emit('close');
  }
}

test('normalizes Home Assistant Bluetooth service info for the ESPHome transport', () => {
  assert.deepEqual(normalizeHomeAssistantAdvertisement({
    address: 'dc:47:11:85:94:2f',
    name: 'M302_2f9485',
    rssi: -65,
    source: 'EC:C9:FF:8F:AE:82',
    connectable: true,
    service_uuids: ['00001910-0000-1000-8000-00805f9b34fb'],
    service_data: { '00001910-0000-1000-8000-00805f9b34fb': 'AABB' },
    manufacturer_data: { 773: '0230' },
  }), {
    address: 'DC:47:11:85:94:2F',
    address_type: null,
    rssi: -65,
    name: 'M302_2f9485',
    service_uuids: ['00001910-0000-1000-8000-00805f9b34fb'],
    service_data: { '00001910-0000-1000-8000-00805f9b34fb': 'aabb' },
    manufacturer_data: { 773: '0230' },
    source: 'EC:C9:FF:8F:AE:82',
    connectable: true,
    time: Number.NaN,
    raw: null,
  });
});

test('authenticates, subscribes, and emits Home Assistant advertisements', async () => {
  FakeWebSocket.instances = [];
  const feed = new HomeAssistantBluetoothFeed({
    supervisorToken: 'test-token',
    WebSocketImpl: FakeWebSocket,
  });
  const started = feed.start(1000);
  const socket = FakeWebSocket.instances[0];

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_required' })));
  assert.deepEqual(socket.sent[0], { type: 'auth', access_token: 'test-token' });

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth_ok' })));
  assert.deepEqual(socket.sent[1], { id: 1, type: 'bluetooth/subscribe_advertisements' });

  socket.emit('message', Buffer.from(JSON.stringify({
    id: 1,
    type: 'result',
    success: true,
    result: null,
  })));
  assert.equal(await started, true);

  const received = new Promise(resolve => feed.once('advertisement', resolve));
  socket.emit('message', Buffer.from(JSON.stringify({
    id: 1,
    type: 'event',
    event: {
      add: [{
        address: 'DC:47:11:85:94:2F',
        name: 'M302_2f9485',
        rssi: -65,
        source: 'EC:C9:FF:8F:AE:82',
        connectable: true,
        service_uuids: ['00001910-0000-1000-8000-00805f9b34fb'],
        service_data: {},
        manufacturer_data: { 773: '0230' },
      }],
    },
  })));

  const event = await received;
  assert.equal(event.transport, 'home_assistant');
  assert.equal(event.proxy, 'EC:C9:FF:8F:AE:82');
  assert.equal(event.device.address, 'DC:47:11:85:94:2F');
  assert.equal(event.device.rssi, -65);
  feed.close();
});

test('fails closed when the Home Assistant feed has no Supervisor token', async () => {
  const feed = new HomeAssistantBluetoothFeed({
    supervisorToken: '',
    WebSocketImpl: FakeWebSocket,
  });
  await assert.rejects(feed.start(100), /SUPERVISOR_TOKEN is required/);
});
