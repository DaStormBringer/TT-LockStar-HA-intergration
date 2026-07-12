'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '0.3.34';
const PATCH_MARKER = 'TT_LOCKSTAR_REFRESH_PERIPHERAL';
const STATE_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_LOCK_STATE';
const STATUS_QUERY_PATCH_MARKER = 'TT_LOCKSTAR_DEADBOLT_STATUS_QUERY';
const STATE_INIT_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_STATE_INIT';

function replaceExactlyOnce(source, expected, replacement, label) {
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(`Cannot patch ${label}: expected one match, found ${count}`);
  }
  return source.replace(expected, replacement);
}

function patchNobleDevice(source) {
  if (source.includes(PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    `        this.peripheral.on("connect", this.onConnect.bind(this));
        this.peripheral.on("disconnect", this.onDisconnect.bind(this));`,
    `        this._ttLockstarOnConnect = this.onConnect.bind(this);
        this._ttLockstarOnDisconnect = this.onDisconnect.bind(this);
        this.peripheral.on("connect", this._ttLockstarOnConnect);
        this.peripheral.on("disconnect", this._ttLockstarOnDisconnect);`,
    'NobleDevice listener setup',
  );

  patched = replaceExactlyOnce(
    patched,
    `    updateFromPeripheral() {
        this.name = this.peripheral.advertisement.localName;`,
    `    updateFromPeripheral(peripheral) {
        // ${PATCH_MARKER}: abandonware/noble may return a new Peripheral object
        // for the same device id after disconnect. Retaining the old object leaves
        // its stale HCI handle in place and makes every reconnect time out.
        if (peripheral && peripheral !== this.peripheral) {
            this.peripheral.removeListener("connect", this._ttLockstarOnConnect);
            this.peripheral.removeListener("disconnect", this._ttLockstarOnDisconnect);
            this.peripheral = peripheral;
            this.peripheral.on("connect", this._ttLockstarOnConnect);
            this.peripheral.on("disconnect", this._ttLockstarOnDisconnect);
            this.connected = this.peripheral.state === "connected";
            this.connecting = this.peripheral.state === "connecting";
            this.resetBusy();
            this.services = new Map();
        }
        this.name = this.peripheral.advertisement.localName;`,
    'NobleDevice peripheral refresh',
  );

  return patched;
}

function patchNobleScanner(source) {
  if (source.includes('updateFromPeripheral(peripheral)')) return source;
  return replaceExactlyOnce(
    source,
    '                nobleDevice.updateFromPeripheral();',
    '                nobleDevice.updateFromPeripheral(peripheral);',
    'NobleScanner rediscovery call',
  );
}

function patchLockStateAdvertisement(source) {
  if (source.includes(STATE_PATCH_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    `        if (this.device.isUnlock) {
            paramsChanged.lockedStatus = this.lockedStatus != LockedStatus_1.LockedStatus.UNLOCKED;
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else {
            paramsChanged.lockedStatus = this.lockedStatus != LockedStatus_1.LockedStatus.LOCKED;
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }`,
    `        // ${STATE_PATCH_MARKER}: for this deadbolt, isUnlock=false means
        // "no unlock event in this advertisement", not a confirmed locked state.
        // Lock state is set to LOCKED only by a successful command or direct read.
        if (this.device.isUnlock) {
            paramsChanged.lockedStatus = this.lockedStatus != LockedStatus_1.LockedStatus.UNLOCKED;
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }`,
    'TTLockApi advertisement state handling',
  );
}

function patchLockStateInitialization(source) {
  if (source.includes(STATE_INIT_PATCH_MARKER)) return source;
  let patched = replaceExactlyOnce(
    source,
    `        if (this.device.isUnlock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else {
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }`,
    `        // ${STATE_INIT_PATCH_MARKER}: idle room-lock advertisements are not
        // proof that a deadbolt is locked. Start unknown unless unlock is explicit.
        if (this.device.isUnlock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else if (this.device.isBicycleLock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }
        else {
            this.lockedStatus = LockedStatus_1.LockedStatus.UNKNOWN;
        }`,
    'TTLockApi constructor state initialization',
  );
  patched = replaceExactlyOnce(
    patched,
    '        this.privateData.pwdInfo = privateData.pwdInfo;',
    `        this.privateData.pwdInfo = privateData.pwdInfo;
        if (data.lockedStatus === LockedStatus_1.LockedStatus.LOCKED
            || data.lockedStatus === LockedStatus_1.LockedStatus.UNLOCKED) {
            this.lockedStatus = data.lockedStatus;
        }`,
    'TTLockApi confirmed state restore',
  );
  return patched;
}

function patchDeadboltStatusQuery(source) {
  if (source.includes(STATUS_QUERY_PATCH_MARKER)) return source;
  let patched = replaceExactlyOnce(
    source,
    '        if (noCache || this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN) {',
    `        // ${STATUS_QUERY_PATCH_MARKER}: searchBycicleStatusCommand is not a
        // reliable deadbolt-position query. Room locks retain confirmed command state.
        if ((noCache || this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN) && this.device.isBicycleLock) {`,
    'TTLock getLockStatus query guard',
  );
  patched = replaceExactlyOnce(
    patched,
    '                if (this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN) {',
    '                if (this.lockedStatus == LockedStatus_1.LockedStatus.UNKNOWN && this.device.isBicycleLock) {',
    'TTLock onConnected status query guard',
  );
  return patched;
}

function patchInstalledSdk(addonRoot = path.resolve(__dirname, '..')) {
  const sdkRoot = path.join(addonRoot, 'node_modules', 'ttlock-sdk-js');
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  if (sdkPackage.version !== EXPECTED_VERSION) {
    throw new Error(`Refusing to patch ttlock-sdk-js ${sdkPackage.version}; expected ${EXPECTED_VERSION}`);
  }

  const devicePath = path.join(sdkRoot, 'dist', 'scanner', 'noble', 'NobleDevice.js');
  const scannerPath = path.join(sdkRoot, 'dist', 'scanner', 'noble', 'NobleScanner.js');
  const lockApiPath = path.join(sdkRoot, 'dist', 'device', 'TTLockApi.js');
  const lockPath = path.join(sdkRoot, 'dist', 'device', 'TTLock.js');
  fs.writeFileSync(devicePath, patchNobleDevice(fs.readFileSync(devicePath, 'utf8')));
  fs.writeFileSync(scannerPath, patchNobleScanner(fs.readFileSync(scannerPath, 'utf8')));
  let lockApiSource = fs.readFileSync(lockApiPath, 'utf8');
  lockApiSource = patchLockStateInitialization(lockApiSource);
  lockApiSource = patchLockStateAdvertisement(lockApiSource);
  fs.writeFileSync(lockApiPath, lockApiSource);
  fs.writeFileSync(lockPath, patchDeadboltStatusQuery(fs.readFileSync(lockPath, 'utf8')));
  console.log(`Patched ttlock-sdk-js ${EXPECTED_VERSION} Noble reconnect handling`);
}

if (require.main === module) patchInstalledSdk();

module.exports = {
  patchInstalledSdk,
  patchDeadboltStatusQuery,
  patchLockStateAdvertisement,
  patchLockStateInitialization,
  patchNobleDevice,
  patchNobleScanner,
};
