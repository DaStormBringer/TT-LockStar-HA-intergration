'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '0.3.34';
const PATCH_MARKER = 'TT_LOCKSTAR_REFRESH_PERIPHERAL';
const STATE_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_LOCK_STATE';
const STATUS_QUERY_PATCH_MARKER = 'TT_LOCKSTAR_DEADBOLT_STATUS_QUERY';
const STATE_INIT_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_STATE_INIT';
const NOBLE_ENTRYPOINT_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_ADAPTER';
const NOBLE_WITH_BINDINGS_SHIM_MARKER = 'TT_LOCKSTAR_WITH_BINDINGS_SHIM';
const NOBLE_DBUS_STATE_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_LIVE_STATE';
const FAST_COMMAND_DEVICE_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_DEVICE_CONNECT';
const FAST_COMMAND_LOCK_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_LOCK_CONNECT';
const FAST_COMMAND_TIMEOUT_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_TIMEOUT';

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

function patchNobleEntrypoint(source) {
  if (source.includes(NOBLE_ENTRYPOINT_PATCH_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    'module.exports = withBindings();',
    `// ${NOBLE_ENTRYPOINT_PATCH_MARKER}: preserve the configured Home Assistant
// adapter when the maintained Noble fork uses its BlueZ D-Bus backend.
const adapterId = process.env.NOBLE_DBUS_ADAPTER_ID;
const hciDeviceId = process.env.NOBLE_HCI_DEVICE_ID;
const bindingOptions = {};
if (adapterId) bindingOptions.adapterId = adapterId;
if (hciDeviceId !== undefined && hciDeviceId !== '') {
  bindingOptions.hciDeviceId = Number.parseInt(hciDeviceId, 10);
}
module.exports = withBindings('default', bindingOptions);`,
    '@stoprocent/noble entrypoint',
  );
}

function createNobleWithBindingsShim() {
  return `'use strict';

// ${NOBLE_WITH_BINDINGS_SHIM_MARKER}: the pinned SDK eagerly imports the old
// Noble constructor path for its disabled websocket scanner. The maintained
// fork still exposes the compatible Noble class internally.
const Noble = require('./lib/noble');

module.exports = function (bindings) {
  return new Noble(bindings);
};
`;
}

function patchNobleDbusStateCache(source) {
  if (source.includes(NOBLE_DBUS_STATE_PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    `      const c = unwrapDict(changed);
      if ('RSSI' in c) {`,
    `      const c = unwrapDict(changed);
      // ${NOBLE_DBUS_STATE_PATCH_MARKER}: keep the object cache synchronized
      // with live BlueZ properties. Reconnect otherwise sees stale Connected
      // and ServicesResolved values and reports a dead session as connected.
      const stored = this._objects.get(device.path) || {};
      stored[DEVICE_IFACE] = Object.assign(stored[DEVICE_IFACE] || {}, c);
      this._objects.set(device.path, stored);
      if ('RSSI' in c) {`,
    '@stoprocent/noble D-Bus live property cache',
  );

  patched = replaceExactlyOnce(
    patched,
    `  _onDeviceDisconnected (id, reason) {
    const device = this._devices.get(id);
    if (!device) return;`,
    `  _onDeviceDisconnected (id, reason) {
    const device = this._devices.get(id);
    if (!device) return;
    const stored = this._objects.get(device.path) || {};
    stored[DEVICE_IFACE] = Object.assign(stored[DEVICE_IFACE] || {}, {
      Connected: false,
      ServicesResolved: false
    });
    this._objects.set(device.path, stored);`,
    '@stoprocent/noble D-Bus disconnect cache reset',
  );

  return patched;
}

function patchFastCommandDeviceConnect(source) {
  if (source.includes(FAST_COMMAND_DEVICE_PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    '    async connect() {',
    `    // ${FAST_COMMAND_DEVICE_PATCH_MARKER}: command-only connections still
    // discover the TTLock service but skip cached GAP/device-information reads.
    async connect(skipBasicInfo = false, connectTimeoutSeconds = 40) {`,
    'TTBluetoothDevice command-only connect signature',
  );
  patched = replaceExactlyOnce(
    patched,
    '            if (await this.device.connect()) {',
    '            if (await this.device.connect(connectTimeoutSeconds)) {',
    'TTBluetoothDevice command connect timeout propagation',
  );
  patched = replaceExactlyOnce(
    patched,
    '                    await this.readBasicInfo();',
    '                    await this.readBasicInfo(skipBasicInfo);',
    'TTBluetoothDevice command-only basic info call',
  );
  patched = replaceExactlyOnce(
    patched,
    `    async readBasicInfo() {
        if (typeof this.device != "undefined") {
            console.log("BLE Device discover services start");
            await this.device.discoverServices();
            console.log("BLE Device discover services end");`,
    `    async readBasicInfo(skipDeviceInfo = false) {
        if (typeof this.device != "undefined") {
            console.log("BLE Device discover services start");
            await this.device.discoverServices();
            console.log("BLE Device discover services end");
            if (skipDeviceInfo) {
                console.log("BLE Device skipping cached generic device information");
                return;
            }`,
    'TTBluetoothDevice command-only generic information skip',
  );

  return patched;
}

function patchFastCommandLockConnect(source) {
  if (source.includes(FAST_COMMAND_LOCK_PATCH_MARKER)) return source;
  let patched = replaceExactlyOnce(
    source,
    '            connected = await this.device.connect();',
    `            // ${FAST_COMMAND_LOCK_PATCH_MARKER}: pass the existing
            // command-only policy through to the Bluetooth setup layer.
            connected = await this.device.connect(
                this.skipDataRead,
                this.skipDataRead ? 6 : 40,
            );`,
    'TTLock command-only device connect propagation',
  );
  patched = replaceExactlyOnce(
    patched,
    '        const maxRetries = 5;',
    `        // ${FAST_COMMAND_TIMEOUT_PATCH_MARKER}: stale command handles must
        // fail quickly so the manager can resume scanning and rediscover a fresh peripheral.
        const maxRetries = this.skipDataRead ? 1 : 5;`,
    'TTLock command-only nested retry limit',
  );
  patched = replaceExactlyOnce(
    patched,
    '                await (0, timingUtil_1.sleep)(1000); // Wait a bit before retrying',
    `                if (retries < maxRetries) {
                    await (0, timingUtil_1.sleep)(this.skipDataRead ? 250 : 1000);
                }`,
    'TTLock command-only nested retry delay',
  );
  return patched;
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
  const rawNobleRoot = path.join(addonRoot, 'node_modules', '@abandonware', 'noble');
  const rawNoblePackage = JSON.parse(fs.readFileSync(path.join(rawNobleRoot, 'package.json'), 'utf8'));
  if (rawNoblePackage.name !== '@abandonware/noble' || rawNoblePackage.version !== '1.9.2-26') {
    throw new Error(`Refusing to use raw-HCI Noble package ${rawNoblePackage.name} ${rawNoblePackage.version}; expected @abandonware/noble 1.9.2-26`);
  }
  const nobleRoot = path.join(addonRoot, 'node_modules', '@ttlockstar', 'noble-dbus');
  const noblePackage = JSON.parse(fs.readFileSync(path.join(nobleRoot, 'package.json'), 'utf8'));
  if (noblePackage.name !== '@stoprocent/noble' || noblePackage.version !== '2.5.5') {
    throw new Error(`Refusing to patch D-Bus Noble package ${noblePackage.name} ${noblePackage.version}; expected @stoprocent/noble 2.5.5`);
  }
  const nobleEntrypointPath = path.join(nobleRoot, 'index.js');
  const nobleWithBindingsPath = path.join(nobleRoot, 'with-bindings.js');
  const bluetoothDevicePath = path.join(sdkRoot, 'dist', 'device', 'TTBluetoothDevice.js');
  const nobleDbusBindingsPath = path.join(nobleRoot, 'lib', 'dbus', 'bindings.js');
  fs.writeFileSync(devicePath, patchNobleDevice(fs.readFileSync(devicePath, 'utf8')));
  fs.writeFileSync(scannerPath, patchNobleScanner(fs.readFileSync(scannerPath, 'utf8')));
  fs.writeFileSync(
    bluetoothDevicePath,
    patchFastCommandDeviceConnect(fs.readFileSync(bluetoothDevicePath, 'utf8')),
  );
  let lockApiSource = fs.readFileSync(lockApiPath, 'utf8');
  lockApiSource = patchLockStateInitialization(lockApiSource);
  lockApiSource = patchLockStateAdvertisement(lockApiSource);
  fs.writeFileSync(lockApiPath, lockApiSource);
  let lockSource = patchDeadboltStatusQuery(fs.readFileSync(lockPath, 'utf8'));
  lockSource = patchFastCommandLockConnect(lockSource);
  fs.writeFileSync(lockPath, lockSource);
  fs.writeFileSync(
    nobleEntrypointPath,
    patchNobleEntrypoint(fs.readFileSync(nobleEntrypointPath, 'utf8')),
  );
  fs.writeFileSync(nobleWithBindingsPath, createNobleWithBindingsShim());
  fs.writeFileSync(
    nobleDbusBindingsPath,
    patchNobleDbusStateCache(fs.readFileSync(nobleDbusBindingsPath, 'utf8')),
  );
  console.log(`Patched ttlock-sdk-js ${EXPECTED_VERSION}; raw-HCI Noble ${rawNoblePackage.version}; D-Bus Noble ${noblePackage.version}`);
}

if (require.main === module) patchInstalledSdk();

module.exports = {
  createNobleWithBindingsShim,
  patchFastCommandDeviceConnect,
  patchFastCommandLockConnect,
  patchInstalledSdk,
  patchDeadboltStatusQuery,
  patchLockStateAdvertisement,
  patchLockStateInitialization,
  patchNobleEntrypoint,
  patchNobleDevice,
  patchNobleDbusStateCache,
  patchNobleScanner,
};
