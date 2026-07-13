'use strict';

const Module = require('node:module');

const RAW_HCI = 'raw_hci';
const DBUS = 'dbus';
const BLUEZ = 'bluez';
const DBUS_PACKAGE = '@ttlockstar/noble-dbus';

function normalizeTransport(value) {
  const transport = String(value || RAW_HCI).trim().toLowerCase();
  if (transport !== RAW_HCI && transport !== DBUS && transport !== BLUEZ) {
    throw new Error(`Unsupported Bluetooth transport: ${transport}`);
  }
  return transport;
}

function mapNobleRequest(request, transport) {
  if (transport !== DBUS) return request;
  if (request === '@abandonware/noble') return DBUS_PACKAGE;
  if (request.startsWith('@abandonware/noble/')) {
    return `${DBUS_PACKAGE}/${request.slice('@abandonware/noble/'.length)}`;
  }
  return request;
}

function installNobleTransport(transportValue = process.env.TTLOCK_BLUETOOTH_TRANSPORT) {
  const transport = normalizeTransport(transportValue);
  if (transport === DBUS && !Module._ttLockstarNobleResolverInstalled) {
    const resolveFilename = Module._resolveFilename;
    Module._resolveFilename = function ttLockstarResolveFilename(request, parent, isMain, options) {
      return resolveFilename.call(this, mapNobleRequest(request, DBUS), parent, isMain, options);
    };
    Module._ttLockstarNobleResolverInstalled = true;
  }
  return transport;
}

module.exports = {
  BLUEZ,
  DBUS,
  DBUS_PACKAGE,
  RAW_HCI,
  installNobleTransport,
  mapNobleRequest,
  normalizeTransport,
};
