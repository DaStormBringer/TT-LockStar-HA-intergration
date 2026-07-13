'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DBUS_PACKAGE,
  mapNobleRequest,
  normalizeTransport,
} = require('../src/nobleTransport');

test('defaults to the hardware-validated raw-HCI transport', () => {
  assert.equal(normalizeTransport(), 'raw_hci');
  assert.equal(normalizeTransport(' RAW_HCI '), 'raw_hci');
});

test('accepts local Bluetooth transports but rejects unknown transports', () => {
  assert.equal(normalizeTransport('dbus'), 'dbus');
  assert.equal(normalizeTransport('bluez'), 'bluez');
  assert.equal(normalizeTransport('esphome_proxy'), 'esphome_proxy');
  assert.throws(() => normalizeTransport('auto'), /Unsupported Bluetooth transport/);
});

test('maps both Noble entrypoints only when D-Bus is selected', () => {
  assert.equal(mapNobleRequest('@abandonware/noble', 'raw_hci'), '@abandonware/noble');
  assert.equal(mapNobleRequest('@abandonware/noble', 'bluez'), '@abandonware/noble');
  assert.equal(mapNobleRequest('@abandonware/noble', 'esphome_proxy'), '@abandonware/noble');
  assert.equal(mapNobleRequest('@abandonware/noble', 'dbus'), DBUS_PACKAGE);
  assert.equal(
    mapNobleRequest('@abandonware/noble/with-bindings', 'dbus'),
    `${DBUS_PACKAGE}/with-bindings`,
  );
  assert.equal(mapNobleRequest('unrelated', 'dbus'), 'unrelated');
});
