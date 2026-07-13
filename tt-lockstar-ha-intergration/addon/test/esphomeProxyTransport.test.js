'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function mockSdk(request, parent, isMain) {
  if (request === 'ttlock-sdk-js/dist/device/TTBluetoothDevice') {
    return { TTBluetoothDevice: { createFromDevice: device => device } };
  }
  if (request === 'ttlock-sdk-js/dist/device/TTLock') {
    return { TTLock: class extends EventEmitter {} };
  }
  if (request === 'ttlock-sdk-js/dist/constant/Lock') {
    return { LockType: { UNKNOWN: 0 } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  EsphomeProxyBluetoothLeService,
  EsphomeProxyCharacteristic,
  EsphomeProxyDevice,
  buildProxyManufacturerData,
  propertyMaskToNames,
} = require('../src/esphomeProxyTransport');

Module._load = originalLoad;

test('maps ESPHome GATT characteristic property bits', () => {
  assert.deepEqual(
    propertyMaskToNames(0x02 | 0x04 | 0x10),
    ['read', 'writeWithoutResponse', 'notify'],
  );
});

test('builds Noble-compatible manufacturer bytes from ESPHome hex data', () => {
  assert.equal(
    buildProxyManufacturerData({ 4660: 'aabb' }).toString('hex'),
    '3412aabb',
  );
});

test('connects, enumerates GATT, writes, and surfaces notifications through the bridge', async () => {
  const calls = [];
  const bridge = new EventEmitter();
  bridge.request = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'connect') return { proxy: 'bedroom-proxy', mtu: 23 };
    if (action === 'services') {
      return [{
        uuid: '00001910-0000-1000-8000-00805f9b34fb',
        handle: 1,
        characteristics: [{
          uuid: '0000fff2-0000-1000-8000-00805f9b34fb',
          handle: 12,
          properties: 0x04 | 0x10,
          descriptors: [],
        }],
      }];
    }
    return true;
  };
  const scanner = { bridge, refreshDevice: async () => true };
  const device = new EsphomeProxyDevice(scanner, {
    address: 'DC:47:11:85:94:2F',
    address_type: 0,
    name: 'M302',
    rssi: -74,
    service_uuids: ['00001910-0000-1000-8000-00805f9b34fb'],
    manufacturer_data: {},
  });

  assert.equal(await device.connect(4.5), true);
  assert.equal(calls[0].payload.timeout, 18);
  assert.equal(device.proxyName, 'bedroom-proxy');
  const services = await device.discoverServices(['1910']);
  const service = services.get('1910');
  const characteristics = await service.discoverCharacteristics();
  const characteristic = characteristics.get('fff2');
  assert.ok(characteristic instanceof EsphomeProxyCharacteristic);
  assert.equal(await characteristic.write(Buffer.from([1, 2, 3]), true), true);
  assert.equal(calls.at(-1).payload.data, '010203');
  assert.equal(calls.at(-1).payload.response, false);

  let notification;
  characteristic.on('dataRead', data => { notification = data; });
  device.handleNotification({ handle: 12, data: 'a1b2' });
  assert.equal(notification.toString('hex'), 'a1b2');
});

test('surfaces duplicate proxy advertisements to the freshness gate', () => {
  const service = Object.create(EsphomeProxyBluetoothLeService.prototype);
  EventEmitter.call(service);
  let updates = 0;
  const existing = { updateFromDevice: () => { updates += 1; } };
  service.btDevices = new Map([['dc471185942f', existing]]);
  let advertised;
  service.on('advertisement', device => { advertised = device; });

  service._onDiscover({ id: 'dc471185942f' });

  assert.equal(updates, 1);
  assert.equal(advertised, existing);
});

test('accepts an exact paired-lock MAC when the ESPHome advertisement omits service UUID 1910', () => {
  const scanner = Object.create(require('../src/esphomeProxyTransport').EsphomeProxyScanner.prototype);
  scanner.uuids = ['1910'];
  scanner.setTargetAddresses(['DC:47:11:85:94:2F']);

  assert.equal(scanner._matchesFilter({
    address: 'DC:47:11:85:94:2F',
    serviceUuids: [],
  }), true);
  assert.equal(scanner._matchesFilter({
    address: 'AA:BB:CC:DD:EE:FF',
    serviceUuids: [],
  }), false);
});
