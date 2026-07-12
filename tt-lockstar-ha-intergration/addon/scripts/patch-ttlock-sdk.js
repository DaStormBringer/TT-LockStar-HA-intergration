'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '0.3.34';
const PATCH_MARKER = 'TT_LOCKSTAR_REFRESH_PERIPHERAL';

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

function patchInstalledSdk(addonRoot = path.resolve(__dirname, '..')) {
  const sdkRoot = path.join(addonRoot, 'node_modules', 'ttlock-sdk-js');
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  if (sdkPackage.version !== EXPECTED_VERSION) {
    throw new Error(`Refusing to patch ttlock-sdk-js ${sdkPackage.version}; expected ${EXPECTED_VERSION}`);
  }

  const devicePath = path.join(sdkRoot, 'dist', 'scanner', 'noble', 'NobleDevice.js');
  const scannerPath = path.join(sdkRoot, 'dist', 'scanner', 'noble', 'NobleScanner.js');
  fs.writeFileSync(devicePath, patchNobleDevice(fs.readFileSync(devicePath, 'utf8')));
  fs.writeFileSync(scannerPath, patchNobleScanner(fs.readFileSync(scannerPath, 'utf8')));
  console.log(`Patched ttlock-sdk-js ${EXPECTED_VERSION} Noble reconnect handling`);
}

if (require.main === module) patchInstalledSdk();

module.exports = {
  patchInstalledSdk,
  patchNobleDevice,
  patchNobleScanner,
};
