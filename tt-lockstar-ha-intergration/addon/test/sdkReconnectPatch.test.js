'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNobleWithBindingsShim,
  patchFastCommandDeviceConnect,
  patchFastCommandLockConnect,
  patchDeadboltStatusQuery,
  patchLockStateAdvertisement,
  patchLockStateInitialization,
  patchNobleEntrypoint,
  patchNobleDevice,
  patchNobleDbusStateCache,
  patchNobleScanner,
} = require('../scripts/patch-ttlock-sdk');

test('provides the legacy Noble constructor path used by the disabled websocket scanner', () => {
  const shim = createNobleWithBindingsShim();

  assert.match(shim, /TT_LOCKSTAR_WITH_BINDINGS_SHIM/);
  assert.match(shim, /require\('\.\/lib\/noble'\)/);
  assert.match(shim, /return new Noble\(bindings\)/);
});

test('configures the maintained Noble fork for the selected D-Bus adapter', () => {
  const source = `const withBindings = require('./lib/resolve-bindings');

module.exports = withBindings();
module.exports.withBindings = withBindings;`;

  const patched = patchNobleEntrypoint(source);

  assert.match(patched, /TT_LOCKSTAR_DBUS_ADAPTER/);
  assert.match(patched, /NOBLE_DBUS_ADAPTER_ID/);
  assert.match(patched, /withBindings\('default', bindingOptions\)/);
  assert.equal(patchNobleEntrypoint(patched), patched);
});

test('patches the SDK to replace a stale Noble peripheral on rediscovery', () => {
  const deviceSource = `
        this.peripheral.on("connect", this.onConnect.bind(this));
        this.peripheral.on("disconnect", this.onDisconnect.bind(this));
    updateFromPeripheral() {
        this.name = this.peripheral.advertisement.localName;
`;
  const scannerSource = '                nobleDevice.updateFromPeripheral();';

  const patchedDevice = patchNobleDevice(deviceSource);
  const patchedScanner = patchNobleScanner(scannerSource);

  assert.match(patchedDevice, /TT_LOCKSTAR_REFRESH_PERIPHERAL/);
  assert.match(patchedDevice, /this\.peripheral = peripheral/);
  assert.match(patchedScanner, /updateFromPeripheral\(peripheral\)/);
  assert.equal(patchNobleDevice(patchedDevice), patchedDevice);
  assert.equal(patchNobleScanner(patchedScanner), patchedScanner);
});

test('keeps the BlueZ D-Bus object cache synchronized across disconnects', () => {
  const source = `      const c = unwrapDict(changed);
      if ('RSSI' in c) {
  _onDeviceDisconnected (id, reason) {
    const device = this._devices.get(id);
    if (!device) return;`;

  const patched = patchNobleDbusStateCache(source);

  assert.match(patched, /TT_LOCKSTAR_DBUS_LIVE_STATE/);
  assert.match(patched, /Object\.assign\(stored\[DEVICE_IFACE\] \|\| \{\}, c\)/);
  assert.match(patched, /Connected: false/);
  assert.match(patched, /ServicesResolved: false/);
  assert.equal(patchNobleDbusStateCache(patched), patched);
});

test('uses a shorter Bluetooth setup path for command-only connections', () => {
  const deviceSource = `    async connect() {
                    await this.readBasicInfo();
    async readBasicInfo() {
        if (typeof this.device != "undefined") {
            console.log("BLE Device discover services start");
            await this.device.discoverServices();
            console.log("BLE Device discover services end");`;
  const lockSource = '            connected = await this.device.connect();';

  const patchedDevice = patchFastCommandDeviceConnect(deviceSource);
  const patchedLock = patchFastCommandLockConnect(lockSource);

  assert.match(patchedDevice, /TT_LOCKSTAR_FAST_COMMAND_DEVICE_CONNECT/);
  assert.match(patchedDevice, /readBasicInfo\(skipBasicInfo\)/);
  assert.match(patchedDevice, /if \(skipDeviceInfo\)/);
  assert.match(patchedLock, /TT_LOCKSTAR_FAST_COMMAND_LOCK_CONNECT/);
  assert.match(patchedLock, /device\.connect\(this\.skipDataRead\)/);
  assert.equal(patchFastCommandDeviceConnect(patchedDevice), patchedDevice);
  assert.equal(patchFastCommandLockConnect(patchedLock), patchedLock);
});

test('fails closed when the expected SDK code is not present', () => {
  assert.throws(() => patchNobleEntrypoint('unexpected source'), /expected one match/);
  assert.throws(() => patchNobleDevice('unexpected source'), /expected one match/);
  assert.throws(() => patchNobleDbusStateCache('unexpected source'), /expected one match/);
  assert.throws(() => patchFastCommandDeviceConnect('unexpected source'), /expected one match/);
  assert.throws(() => patchFastCommandLockConnect('unexpected source'), /expected one match/);
  assert.throws(() => patchNobleScanner('unexpected source'), /expected one match/);
});

test('does not infer locked state from an idle unlock advertisement flag', () => {
  const source = `        if (this.device.isUnlock) {
            paramsChanged.lockedStatus = this.lockedStatus != LockedStatus_1.LockedStatus.UNLOCKED;
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else {
            paramsChanged.lockedStatus = this.lockedStatus != LockedStatus_1.LockedStatus.LOCKED;
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }`;

  const patched = patchLockStateAdvertisement(source);

  assert.match(patched, /TT_LOCKSTAR_CONFIRMED_LOCK_STATE/);
  assert.doesNotMatch(patched, /LockedStatus\.LOCKED/);
  assert.equal(patchLockStateAdvertisement(patched), patched);
});

test('does not use the bicycle status command as a room-deadbolt state query', () => {
  const source = `        if (noCache || this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN) {
                if (this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN) {`;

  const patched = patchDeadboltStatusQuery(source);

  assert.match(patched, /TT_LOCKSTAR_DEADBOLT_STATUS_QUERY/);
  assert.equal((patched.match(/this\.device\.isBicycleLock/g) || []).length, 2);
  assert.equal(patchDeadboltStatusQuery(patched), patched);
});

test('starts room deadbolts unknown and restores only confirmed saved state', () => {
  const source = `        if (this.device.isUnlock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else {
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }
        this.privateData.pwdInfo = privateData.pwdInfo;`;

  const patched = patchLockStateInitialization(source);

  assert.match(patched, /TT_LOCKSTAR_CONFIRMED_STATE_INIT/);
  assert.match(patched, /LockedStatus\.UNKNOWN/);
  assert.match(patched, /data\.lockedStatus === LockedStatus_1\.LockedStatus\.LOCKED/);
  assert.equal(patchLockStateInitialization(patched), patched);
});
