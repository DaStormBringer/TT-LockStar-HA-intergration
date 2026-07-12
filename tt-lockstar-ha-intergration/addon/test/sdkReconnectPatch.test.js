'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  patchDeadboltStatusQuery,
  patchLockStateAdvertisement,
  patchNobleDevice,
  patchNobleScanner,
} = require('../scripts/patch-ttlock-sdk');

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

test('fails closed when the expected SDK code is not present', () => {
  assert.throws(() => patchNobleDevice('unexpected source'), /expected one match/);
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
