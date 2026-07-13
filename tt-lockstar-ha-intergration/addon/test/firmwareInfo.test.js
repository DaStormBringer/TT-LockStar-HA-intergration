'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Keep the unit test from opening a raw-HCI socket in its isolated container.
process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';

const { DeviceInfoEnum } = require('ttlock-sdk-js/dist/constant');
const manager = require('../src/manager');
const WsApi = require('../api/WsApi');

test('firmware revision uses one read-only command over a command-only connection', async (t) => {
  const address = 'DC:47:11:85:94:2F';
  const originalPairedLocks = manager.pairedLocks;
  const originalConnectLock = manager._connectLock;
  const originalConnectQueue = manager.connectQueue;
  const originalReservations = manager.firmwareReadReservations;
  t.after(() => {
    manager.pairedLocks = originalPairedLocks;
    manager._connectLock = originalConnectLock;
    manager.connectQueue = originalConnectQueue;
    manager.firmwareReadReservations = originalReservations;
  });

  let requestedInfoType;
  const lock = {
    getFirmware: () => 'unknown',
    readDeviceInfoCommand: async (infoType) => {
      requestedInfoType = infoType;
      return Buffer.from('2.1.16.705\0');
    },
  };
  manager.pairedLocks = new Map([[address, lock]]);
  manager.connectQueue = new Set([address]);
  manager.firmwareReadReservations = new Set();
  lock._ttLockstarLastAdvertisementAt = Date.now();
  manager._connectLock = async (candidate, readData) => {
    assert.equal(candidate, lock);
    assert.equal(readData, false);
    assert.equal(manager.firmwareReadReservations.has(address), true);
    assert.equal(manager.connectQueue.has(address), false);
    return true;
  };

  const info = await manager.getFirmwareInfo(address);

  assert.equal(requestedInfoType, DeviceInfoEnum.FIRMWARE_REVISION);
  assert.deepEqual(info, {
    address,
    command: 'COMM_READ_DEVICE_INFO',
    infoType: 'FIRMWARE_REVISION',
    firmwareRevision: '2.1.16.705',
    gattFirmware: 'unknown',
    readOnly: true,
  });
  assert.equal(manager.firmwareReadReservations.has(address), false);
});

test('firmware response has a dedicated websocket message type', async () => {
  const sent = [];
  const api = new WsApi({ send: payload => sent.push(JSON.parse(payload)) });
  const firmwareInfo = {
    address: 'DC:47:11:85:94:2F',
    firmwareRevision: '2.1.16.705',
    readOnly: true,
  };

  await api.sendFirmwareInfo(firmwareInfo);

  assert.deepEqual(sent, [{ type: 'firmware', data: firmwareInfo }]);
});

test('websocket firmware request disconnects after the bounded read', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/index.js'), 'utf8');
  assert.match(source, /case "firmware"/);
  assert.match(source, /manager\.getFirmwareInfo\(msg\.data\.address\)/);
  assert.match(source, /api\.sendFirmwareInfo\(firmwareInfo\)/);
  assert.match(source, /await manager\.disconnectLock\(msg\.data\.address\)/);
});
