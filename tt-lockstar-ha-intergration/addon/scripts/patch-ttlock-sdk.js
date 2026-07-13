'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '0.3.34';
const PATCH_MARKER = 'TT_LOCKSTAR_REFRESH_PERIPHERAL';
const STATE_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_LOCK_STATE';
const STATUS_QUERY_PATCH_MARKER = 'TT_LOCKSTAR_DEADBOLT_STATUS_QUERY';
const STATE_INIT_PATCH_MARKER = 'TT_LOCKSTAR_CONFIRMED_STATE_INIT';
const COMMAND_CONNECT_STATE_PATCH_MARKER = 'TT_LOCKSTAR_COMMAND_CONNECT_STATE';
const NOBLE_ENTRYPOINT_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_ADAPTER';
const NOBLE_WITH_BINDINGS_SHIM_MARKER = 'TT_LOCKSTAR_WITH_BINDINGS_SHIM';
const NOBLE_DBUS_STATE_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_LIVE_STATE';
const NOBLE_DBUS_DUPLICATE_DISCOVERY_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_DUPLICATE_DISCOVERY';
const NOBLE_DBUS_DEVICE_REFRESH_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_DEVICE_REFRESH';
const FAST_COMMAND_DEVICE_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_DEVICE_CONNECT';
const FAST_COMMAND_LOCK_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_LOCK_CONNECT';
const FAST_COMMAND_TIMEOUT_PATCH_MARKER = 'TT_LOCKSTAR_FAST_COMMAND_TIMEOUT';
const TARGETED_NOBLE_DISCOVERY_PATCH_MARKER = 'TT_LOCKSTAR_TARGETED_SERVICE_DISCOVERY';
const TARGETED_COMMAND_DISCOVERY_PATCH_MARKER = 'TT_LOCKSTAR_TARGETED_COMMAND_DISCOVERY';
const DBUS_COMMAND_PACING_PATCH_MARKER = 'TT_LOCKSTAR_DBUS_COMMAND_PACING';
const ESPHOME_ATOMIC_WRITE_PATCH_MARKER = 'TT_LOCKSTAR_ESPHOME_ATOMIC_WRITE';
const ADMIN_UNLOCK_PATCH_MARKER = 'TT_LOCKSTAR_ADMIN_UNLOCK';
const DIRECT_COMMAND_ENVELOPE_PATCH_MARKER = 'TT_LOCKSTAR_DIRECT_COMMAND_ENVELOPE';

function replaceExactlyOnce(source, expected, replacement, label) {
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(`Cannot patch ${label}: expected one match, found ${count}`);
  }
  return source.replace(expected, replacement);
}

function patchDirectCommandEnvelopeImport(source) {
  if (source.includes(DIRECT_COMMAND_ENVELOPE_PATCH_MARKER)) return source;
  let patched = replaceExactlyOnce(
    source,
    'const __1 = require("..");',
    `// ${DIRECT_COMMAND_ENVELOPE_PATCH_MARKER}: avoid importing the SDK barrel,
// which eagerly initializes Noble even when the native BlueZ client is selected.
const CommandEnvelope_1 = require("../api/CommandEnvelope");`,
    'TTLockApi direct CommandEnvelope import',
  );
  const usageCount = (patched.match(/__1\.CommandEnvelope/g) || []).length;
  if (usageCount === 0) {
    throw new Error('Cannot patch TTLockApi direct CommandEnvelope usage: found no matches');
  }
  patched = patched.replace(/__1\.CommandEnvelope/g, 'CommandEnvelope_1.CommandEnvelope');
  return patched;
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

function patchTargetedNobleDiscovery(source) {
  if (source.includes(TARGETED_NOBLE_DISCOVERY_PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    '    async discoverServices() {',
    `    // ${TARGETED_NOBLE_DISCOVERY_PATCH_MARKER}: command connections request
    // only the TTLock service instead of waiting for every advertised service.
    async discoverServices(serviceUuids = []) {`,
    'NobleDevice targeted service discovery signature',
  );
  patched = replaceExactlyOnce(
    patched,
    '            this.peripheral.discoverServices([], (error, discoveredServices) => {\n                services = discoveredServices;\n            });',
    `            this.peripheral.discoverServices(serviceUuids, (error, discoveredServices) => {
                if (!error && Array.isArray(discoveredServices)) {
                    services = discoveredServices;
                }
            });`,
    'NobleDevice targeted service discovery call',
  );
  return patched;
}

function patchTargetedCommandDiscovery(source) {
  if (source.includes(TARGETED_COMMAND_DISCOVERY_PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    '            await this.device.discoverServices();',
    `            // ${TARGETED_COMMAND_DISCOVERY_PATCH_MARKER}: the command path
            // needs only service 1910; metadata refreshes retain full discovery.
            await this.device.discoverServices(skipDeviceInfo ? ["1910"] : []);`,
    'TTBluetoothDevice targeted command service discovery',
  );
  patched = replaceExactlyOnce(
    patched,
    '                await service.readCharacteristics();\n                if (service.characteristics.has("fff4")) {',
    `                // Discover the command characteristics without reading every
                // readable value before notification subscription.
                await service.discoverCharacteristics();
                if (service.characteristics.has("fff4")) {`,
    'TTBluetoothDevice command characteristic discovery',
  );
  return patched;
}

function patchDbusCommandPacing(source) {
  if (source.includes(DBUS_COMMAND_PACING_PATCH_MARKER)) return source;

  return replaceExactlyOnce(
    source,
    `            const written = await characteristic.write(data.subarray(index, index + Math.min(MTU, remaining)), true);
            if (!written) {
                return false;
            }
            // await sleep(10);
            index += MTU;`,
    `            const fragment = data.subarray(index, index + Math.min(MTU, remaining));
            const written = await characteristic.write(fragment, true);
            if (!written) {
                return false;
            }
            // ${DBUS_COMMAND_PACING_PATCH_MARKER}: WriteValue returns as soon as
            // A GATT transport can accept a write-without-response fragment before
            // the lock consumes it. Pace multi-part commands on those transports.
            if (["dbus", "bluez", "esphome_proxy"].includes(process.env.TTLOCK_BLUETOOTH_TRANSPORT)) {
                const fragmentNumber = Math.floor(index / MTU) + 1;
                const fragmentCount = Math.ceil(data.length / MTU);
                console.log(\`[Bluetooth][GATT] command fragment \${fragmentNumber}/\${fragmentCount} accepted (\${fragment.length} bytes)\`);
                if (index + MTU < data.length) {
                    await (0, timingUtil_1.sleep)(20);
                }
            }
            index += MTU;`,
    'TTBluetoothDevice D-Bus command pacing',
  );
}

function patchEsphomeAtomicWrite(source) {
  if (source.includes(ESPHOME_ATOMIC_WRITE_PATCH_MARKER)) return source;

  return replaceExactlyOnce(
    source,
    `        let index = 0;
        do {`,
    `        let index = 0;
        // ${ESPHOME_ATOMIC_WRITE_PATCH_MARKER}: keep a multipart TTLock command
        // inside one Node-to-bridge request. This preserves the required pacing
        // while avoiding three process/API round trips during a short wake window.
        if (process.env.TTLOCK_BLUETOOTH_TRANSPORT === "esphome_proxy"
            && typeof characteristic.writeFragments === "function") {
            const fragments = [];
            while (index < data.length) {
                fragments.push(data.subarray(index, index + Math.min(MTU, data.length - index)));
                index += MTU;
            }
            // ESPHome's no-response API call confirms only that the fragment was
            // queued to the proxy, not that the lock consumed it. Give each BLE
            // fragment one connection interval to drain before queuing the next.
            const written = await characteristic.writeFragments(fragments, true, 100);
            if (written) {
                fragments.forEach((fragment, fragmentIndex) => {
                    console.log(\`[Bluetooth][GATT] command fragment \${fragmentIndex + 1}/\${fragments.length} accepted (\${fragment.length} bytes)\`);
                });
            }
            return written;
        }
        do {`,
    'TTBluetoothDevice ESPHome atomic multipart write',
  );
}

function patchAdminUnlock(source) {
  if (source.includes(ADMIN_UNLOCK_PATCH_MARKER)) return source;

  return replaceExactlyOnce(
    source,
    `    async unlock() {
        if (!this.isConnected()) {
            throw new Error("Lock is not connected");
        }
        if (!this.initialized) {
            throw new Error("Lock is in pairing mode");
        }
        try {
            console.log("========= check user time");
            const psFromLock = await this.checkUserTime();
            console.log("========= check user time", psFromLock);
            console.log("========= unlock");`,
    `    async unlock() {
        if (!this.isConnected()) {
            throw new Error("Lock is not connected");
        }
        if (!this.initialized) {
            throw new Error("Lock is in pairing mode");
        }
        try {
            // ${ADMIN_UNLOCK_PATCH_MARKER}: TTLock's documented administrator
            // path authenticates unlock with CHECK_ADMIN. Ordinary eKeys retain
            // CHECK_USER_TIME and its validity window.
            const hasAdminPassword = this.privateData.admin
                && typeof this.privateData.admin.adminPs !== "undefined";
            console.log(hasAdminPassword ? "========= check admin for unlock" : "========= check user time");
            const psFromLock = hasAdminPassword
                ? await this.checkAdminCommand()
                : await this.checkUserTime();
            console.log(hasAdminPassword ? "========= check admin for unlock" : "========= check user time", psFromLock);
            console.log("========= unlock");`,
    'TTLock administrator unlock authentication',
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

function patchNobleDbusDuplicateDiscovery(source) {
  if (source.includes(NOBLE_DBUS_DUPLICATE_DISCOVERY_PATCH_MARKER)) return source;

  let patched = replaceExactlyOnce(
    source,
    `        if (unwrapped[DEVICE_IFACE] && this._isUnderAdapter(path)) {
          const address = unwrapped[DEVICE_IFACE].Address || devicePathToAddress(path);
          if (address && this._devices.has(addressToId(address))) continue;
          this._handleDeviceProps(path, unwrapped[DEVICE_IFACE]);
        }`,
    `        if (unwrapped[DEVICE_IFACE] && this._isUnderAdapter(path)) {
          const address = unwrapped[DEVICE_IFACE].Address || devicePathToAddress(path);
          const id = address && addressToId(address);
          if (id && this._devices.has(id)) {
            // ${NOBLE_DBUS_DUPLICATE_DISCOVERY_PATCH_MARKER}: a disconnected
            // device loses its PropertiesChanged listener. Reattach it when
            // monitoring restarts without treating cached data as a live advert.
            this._ensureDeviceProxy(id).catch(err => debug('device proxy refresh failed: %s', err.message));
            continue;
          }
          this._handleDeviceProps(path, unwrapped[DEVICE_IFACE]);
        }`,
    '@stoprocent/noble cached device listener refresh',
  );

  patched = replaceExactlyOnce(
    patched,
    `    this.emit(
      'discover',
      id,
      device.address,
      device.addressType,
      device.connectable,
      device.advertisement,
      device.rssi,
      device.scannable
    );
  }`,
    `    this.emit(
      'discover',
      id,
      device.address,
      device.addressType,
      device.connectable,
      device.advertisement,
      device.rssi,
      device.scannable
    );
    // Listen while scanning so BlueZ DuplicateData property updates can be
    // surfaced as Noble duplicate discovery events.
    this._ensureDeviceProxy(id).catch(err => debug('device proxy setup failed: %s', err.message));
  }`,
    '@stoprocent/noble scanning device listener setup',
  );

  patched = replaceExactlyOnce(
    patched,
    `      this._objects.set(device.path, stored);
      if ('RSSI' in c) {`,
    `      this._objects.set(device.path, stored);
      const advertisementKeys = ['RSSI', 'ManufacturerData', 'ServiceData', 'UUIDs', 'Name', 'Alias'];
      if (this._isScanning && advertisementKeys.some(key => key in c)) {
        Object.assign(device.advertisement, buildAdvertisement(stored[DEVICE_IFACE]));
        if (typeof stored[DEVICE_IFACE].RSSI === 'number') device.rssi = stored[DEVICE_IFACE].RSSI;
        this.emit(
          'discover',
          id,
          device.address,
          device.addressType,
          device.connectable,
          device.advertisement,
          device.rssi,
          device.scannable
        );
      }
      if ('RSSI' in c) {`,
    '@stoprocent/noble duplicate discovery property bridge',
  );

  return patched;
}

function patchNobleDbusDeviceRefresh(source) {
  if (source.includes(NOBLE_DBUS_DEVICE_REFRESH_PATCH_MARKER)) return source;

  return replaceExactlyOnce(
    source,
    `  // ---- Connect / disconnect ----

  connect (peripheralUuid, _parameters) {`,
    `  // ---- Connect / disconnect ----

  // ${NOBLE_DBUS_DEVICE_REFRESH_PATCH_MARKER}: discard only an unpaired
  // target's stale BlueZ object so the next InterfacesAdded is evidence of
  // a real radio advertisement. TTLock protocol credentials live above BlueZ.
  async refreshDevice (peripheralUuid) {
    const id = normalizeId(peripheralUuid);
    const device = this._devices.get(id);
    if (!device || !device.path || !this._adapterIface) return false;
    const stored = this._objects.get(device.path) || {};
    const props = stored[DEVICE_IFACE] || {};
    if (props.Paired) {
      throw new Error(\`refusing to remove paired BlueZ device \${device.address}\`);
    }
    await this._adapterIface.RemoveDevice(device.path);
    return true;
  }

  connect (peripheralUuid, _parameters) {`,
    '@stoprocent/noble targeted unpaired device refresh',
  );
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
                this.skipDataRead
                    ? (process.env.TTLOCK_BLUETOOTH_TRANSPORT === "esphome_proxy" ? 10 : 4.5)
                    : 40,
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

function patchCommandConnectState(source) {
  if (source.includes(COMMAND_CONNECT_STATE_PATCH_MARKER)) return source;
  return replaceExactlyOnce(
    source,
    `        else {
            if (this.device.isUnlock) {
                this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
            }
            else {
                this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
            }
        }
        // are we still connected ? It is possible the lock will disconnect while reading general data`,
    `        // ${COMMAND_CONNECT_STATE_PATCH_MARKER}: a command-only reconnect is
        // transport setup, not proof of deadbolt position. Preserve confirmed
        // room-lock state until the physical command or operation log succeeds.
        else if (this.device.isUnlock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.UNLOCKED;
        }
        else if (this.device.isBicycleLock) {
            this.lockedStatus = LockedStatus_1.LockedStatus.LOCKED;
        }
        // are we still connected ? It is possible the lock will disconnect while reading general data`,
    'TTLock command-only connection state handling',
  );
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
  let nobleDeviceSource = patchNobleDevice(fs.readFileSync(devicePath, 'utf8'));
  nobleDeviceSource = patchTargetedNobleDiscovery(nobleDeviceSource);
  fs.writeFileSync(devicePath, nobleDeviceSource);
  fs.writeFileSync(scannerPath, patchNobleScanner(fs.readFileSync(scannerPath, 'utf8')));
  fs.writeFileSync(
    bluetoothDevicePath,
    patchDbusCommandPacing(
      patchEsphomeAtomicWrite(
        patchTargetedCommandDiscovery(
          patchFastCommandDeviceConnect(fs.readFileSync(bluetoothDevicePath, 'utf8')),
        ),
      ),
    ),
  );
  let lockApiSource = fs.readFileSync(lockApiPath, 'utf8');
  lockApiSource = patchDirectCommandEnvelopeImport(lockApiSource);
  lockApiSource = patchLockStateInitialization(lockApiSource);
  lockApiSource = patchLockStateAdvertisement(lockApiSource);
  fs.writeFileSync(lockApiPath, lockApiSource);
  let lockSource = patchAdminUnlock(fs.readFileSync(lockPath, 'utf8'));
  lockSource = patchDeadboltStatusQuery(lockSource);
  lockSource = patchFastCommandLockConnect(lockSource);
  lockSource = patchCommandConnectState(lockSource);
  fs.writeFileSync(lockPath, lockSource);
  fs.writeFileSync(
    nobleEntrypointPath,
    patchNobleEntrypoint(fs.readFileSync(nobleEntrypointPath, 'utf8')),
  );
  fs.writeFileSync(nobleWithBindingsPath, createNobleWithBindingsShim());
  fs.writeFileSync(
    nobleDbusBindingsPath,
    patchNobleDbusDeviceRefresh(
      patchNobleDbusDuplicateDiscovery(
        patchNobleDbusStateCache(fs.readFileSync(nobleDbusBindingsPath, 'utf8')),
      ),
    ),
  );
  console.log(`Patched ttlock-sdk-js ${EXPECTED_VERSION}; raw-HCI Noble ${rawNoblePackage.version}; D-Bus Noble ${noblePackage.version}`);
}

if (require.main === module) patchInstalledSdk();

module.exports = {
  createNobleWithBindingsShim,
  patchCommandConnectState,
  patchFastCommandDeviceConnect,
  patchFastCommandLockConnect,
  patchInstalledSdk,
  patchDeadboltStatusQuery,
  patchDirectCommandEnvelopeImport,
  patchDbusCommandPacing,
  patchEsphomeAtomicWrite,
  patchAdminUnlock,
  patchLockStateAdvertisement,
  patchLockStateInitialization,
  patchNobleEntrypoint,
  patchNobleDevice,
  patchNobleDbusStateCache,
  patchNobleDbusDuplicateDiscovery,
  patchNobleDbusDeviceRefresh,
  patchNobleScanner,
  patchTargetedCommandDiscovery,
  patchTargetedNobleDiscovery,
};
