'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function mockSdk(request, parent, isMain) {
  if (request === 'ttlock-sdk-js/dist/device/TTBluetoothDevice') {
    return { TTBluetoothDevice: { createFromDevice: () => ({}) } };
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
  BluezCharacteristic,
  BluezBluetoothLeService,
  BluezDevice,
  addressToId,
  buildManufacturerData,
  expandUuid,
  flagsToProperties,
  normalizeUuid,
  unwrapDict,
} = require('../src/bluezTransport');

Module._load = originalLoad;

test('normalizes TTLock and BlueZ identifiers', () => {
  assert.equal(addressToId('DC:47:11:85:94:2F'), 'dc471185942f');
  assert.equal(normalizeUuid('00001910-0000-1000-8000-00805F9B34FB'), '1910');
  assert.equal(expandUuid('1910'), '00001910-0000-1000-8000-00805f9b34fb');
});

test('builds Noble-compatible manufacturer bytes without Noble', () => {
  const result = buildManufacturerData({
    4660: { signature: 'ay', value: Buffer.from([0xaa, 0xbb]) },
  });
  assert.equal(result.toString('hex'), '3412aabb');
});

test('maps BlueZ GATT flags to the SDK interface', () => {
  assert.deepEqual(
    flagsToProperties(['read', 'write-without-response', 'notify', 'notify']),
    ['read', 'writeWithoutResponse', 'notify'],
  );
});

test('unwraps dbus-next property dictionaries', () => {
  assert.deepEqual(unwrapDict({
    RSSI: { signature: 'n', value: -74 },
    Name: { signature: 's', value: 'M302' },
  }), { RSSI: -74, Name: 'M302' });
});

test('connects through Device1 and waits for resolved GATT services', async () => {
  let connectCalls = 0;
  let connected = false;
  const proxy = {
    getInterface(name) {
      if (name === 'org.bluez.Device1') {
        return {
          Connect: async () => {
            connectCalls += 1;
            connected = true;
          },
        };
      }
      return {
        GetAll: async () => ({
          Address: { signature: 's', value: 'DC:47:11:85:94:2F' },
          Connected: { signature: 'b', value: connected },
          ServicesResolved: { signature: 'b', value: connected },
        }),
      };
    },
  };
  const scanner = {
    bus: { getProxyObject: async () => proxy },
  };
  const device = new BluezDevice(scanner, '/org/bluez/hci0/dev_DC_47_11_85_94_2F', {
    Address: 'DC:47:11:85:94:2F',
    Connected: false,
    ServicesResolved: false,
  });

  assert.equal(await device.connect(1), true);
  assert.equal(connectCalls, 1);
  assert.equal(device.state, 'connected');
});

test('writes command fragments directly through GattCharacteristic1', async () => {
  const writes = [];
  class Variant {
    constructor(signature, value) {
      this.signature = signature;
      this.value = value;
    }
  }
  const scanner = {
    dbus: { Variant },
    bus: {
      getProxyObject: async () => ({
        getInterface: () => ({
          WriteValue: async (data, options) => writes.push({ data, options }),
        }),
      }),
    },
  };
  const device = {
    scanner,
    checkBusy: () => true,
    resetBusy: () => false,
  };
  const characteristic = new BluezCharacteristic(device, '/characteristic', {
    UUID: '0000fff2-0000-1000-8000-00805f9b34fb',
    Flags: ['write-without-response'],
  });

  assert.equal(await characteristic.write(Buffer.from([1, 2, 3]), true), true);
  assert.equal(writes[0].data.toString('hex'), '010203');
  assert.equal(writes[0].options.type.value, 'command');
});

test('surfaces every duplicate native advertisement to the command freshness gate', () => {
  const service = Object.create(BluezBluetoothLeService.prototype);
  EventEmitter.call(service);
  let updates = 0;
  const existing = {
    updateFromDevice: () => { updates += 1; },
  };
  service.btDevices = new Map([['lock-id', existing]]);
  let advertised;
  service.on('advertisement', device => { advertised = device; });

  service._onDiscover({ id: 'lock-id' });

  assert.equal(updates, 1);
  assert.equal(advertised, existing);
});

test('removes only an unpaired native BlueZ cache after disconnect', async () => {
  let disconnectCalls = 0;
  let removeCalls = 0;
  const scanner = {
    bus: {
      getProxyObject: async () => ({
        getInterface: () => ({
          Disconnect: async () => { disconnectCalls += 1; },
        }),
      }),
    },
    removeDevice: async () => {
      removeCalls += 1;
      return true;
    },
  };
  const device = new BluezDevice(scanner, '/device', {
    Address: 'DC:47:11:85:94:2F',
    Connected: true,
    ServicesResolved: true,
    Paired: false,
  });

  assert.equal(await device.disconnect(), true);
  assert.equal(disconnectCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(device.state, 'disconnected');
});

test('preserves host-paired BlueZ cache after disconnect', async () => {
  let removeCalls = 0;
  const scanner = {
    bus: {
      getProxyObject: async () => ({
        getInterface: () => ({ Disconnect: async () => {} }),
      }),
    },
    removeDevice: async () => { removeCalls += 1; },
  };
  const device = new BluezDevice(scanner, '/device', {
    Address: 'DC:47:11:85:94:2F',
    Connected: true,
    ServicesResolved: true,
    Paired: true,
  });

  await device.disconnect();
  assert.equal(removeCalls, 0);
});
