'use strict';

const { EventEmitter } = require('node:events');
const { TTBluetoothDevice } = require('ttlock-sdk-js/dist/device/TTBluetoothDevice');
const { TTLock } = require('ttlock-sdk-js/dist/device/TTLock');
const { LockType } = require('ttlock-sdk-js/dist/constant/Lock');

const BLUEZ_SERVICE = 'org.bluez';
const ROOT_PATH = '/';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const DEVICE_IFACE = 'org.bluez.Device1';
const GATT_SERVICE_IFACE = 'org.bluez.GattService1';
const GATT_CHAR_IFACE = 'org.bluez.GattCharacteristic1';
const GATT_DESC_IFACE = 'org.bluez.GattDescriptor1';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const ADVERTISEMENT_KEYS = new Set(['RSSI', 'ManufacturerData', 'ServiceData', 'UUIDs', 'Name', 'Alias', 'TxPower']);

const FLAG_TO_PROPERTY = {
  broadcast: 'broadcast',
  read: 'read',
  'write-without-response': 'writeWithoutResponse',
  write: 'write',
  notify: 'notify',
  indicate: 'indicate',
  'authenticated-signed-writes': 'authenticatedSignedWrites',
  'reliable-write': 'extendedProperties',
  'writable-auxiliaries': 'extendedProperties',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUuid(uuid) {
  const value = String(uuid || '').toLowerCase().replace(/^0x/, '');
  const match = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(value);
  return match ? match[1] : value;
}

function expandUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  return normalized.length === 4
    ? `0000${normalized}-0000-1000-8000-00805f9b34fb`
    : normalized;
}

function addressToId(address) {
  return String(address || '').replace(/:/g, '').toLowerCase();
}

function unwrapVariant(value) {
  if (value && typeof value === 'object' && 'signature' in value && 'value' in value) {
    return value.value;
  }
  return value;
}

function unwrapDict(dict) {
  const result = {};
  for (const [key, value] of Object.entries(dict || {})) result[key] = unwrapVariant(value);
  return result;
}

function bufferFrom(value) {
  const raw = unwrapVariant(value);
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(raw || []);
}

function buildManufacturerData(data) {
  const buffers = [];
  for (const [companyId, payload] of Object.entries(data || {})) {
    const id = Number(companyId) & 0xffff;
    buffers.push(Buffer.concat([
      Buffer.from([id & 0xff, (id >> 8) & 0xff]),
      bufferFrom(payload),
    ]));
  }
  return buffers.length > 0 ? Buffer.concat(buffers) : Buffer.alloc(0);
}

function flagsToProperties(flags) {
  return [...new Set((flags || []).map(flag => FLAG_TO_PROPERTY[flag]).filter(Boolean))];
}

function selectedAdapterId() {
  if (process.env.NOBLE_DBUS_ADAPTER_ID) return process.env.NOBLE_DBUS_ADAPTER_ID;
  const configured = String(process.env.NOBLE_HCI_DEVICE_ID || '0');
  return configured.startsWith('hci') ? configured : `hci${configured}`;
}

class BluezScanner extends EventEmitter {
  constructor(uuids = [], options = {}) {
    super();
    this.uuids = [...new Set(uuids.map(normalizeUuid))];
    this.adapterId = options.adapterId || selectedAdapterId();
    this.scannerState = 'unknown';
    this.devices = new Map();
    this.objects = new Map();
    this.devicePropertyListeners = new Map();
    this.initialDevicesSurfaced = false;
    this.scanning = false;
    this.dbus = options.dbus || null;
    this.bus = options.bus || null;
    this._initPromise = Promise.resolve().then(() => this._init()).catch(error => {
      this.initError = error;
      this.scannerState = 'unsupported';
      console.error('[Bluetooth][BlueZ] initialization failed:', error);
      return false;
    });
  }

  getState() {
    return this.scannerState;
  }

  async _init() {
    if (!this.dbus) this.dbus = require('dbus-next');
    if (!this.bus) this.bus = this.dbus.systemBus();
    const root = await this.bus.getProxyObject(BLUEZ_SERVICE, ROOT_PATH);
    this.objectManager = root.getInterface(OBJECT_MANAGER_IFACE);
    this.objectManager.on('InterfacesAdded', (path, interfaces) => this._onInterfacesAdded(path, interfaces));
    this.objectManager.on('InterfacesRemoved', (path, interfaces) => this._onInterfacesRemoved(path, interfaces));
    await this.refreshObjects();

    this.adapterPath = [...this.objects.entries()].find(([path, interfaces]) => (
      interfaces[ADAPTER_IFACE] && path.endsWith(`/${this.adapterId}`)
    ))?.[0];
    if (!this.adapterPath) throw new Error(`BlueZ adapter ${this.adapterId} was not found`);

    const adapterProxy = await this.bus.getProxyObject(BLUEZ_SERVICE, this.adapterPath);
    this.adapter = adapterProxy.getInterface(ADAPTER_IFACE);
    const attach = [];
    for (const [path, interfaces] of this.objects) {
      if (interfaces[DEVICE_IFACE] && path.startsWith(`${this.adapterPath}/`)) {
        const device = this._upsertDevice(path, interfaces[DEVICE_IFACE]);
        attach.push(this._attachDeviceProperties(device));
      }
    }
    await Promise.all(attach);
    this.scannerState = 'stopped';
    this.emit('ready');
  }

  async refreshObjects() {
    const managed = await this.objectManager.GetManagedObjects();
    const refreshed = new Map();
    for (const [path, interfaces] of Object.entries(managed || {})) {
      const values = {};
      for (const [name, properties] of Object.entries(interfaces || {})) {
        values[name] = unwrapDict(properties);
      }
      refreshed.set(path, values);
    }
    this.objects = refreshed;
    return this.objects;
  }

  async startScan() {
    await this._initPromise;
    if (this.initError) throw this.initError;
    if (this.scanning) return false;
    this.scannerState = 'starting';
    const filter = {
      Transport: new this.dbus.Variant('s', 'le'),
      DuplicateData: new this.dbus.Variant('b', true),
    };
    if (this.uuids.length > 0) {
      filter.UUIDs = new this.dbus.Variant('as', this.uuids.map(expandUuid));
    }
    await this.adapter.SetDiscoveryFilter(filter);
    await this.adapter.StartDiscovery();
    this.scanning = true;
    this.scannerState = 'scanning';
    if (!this.initialDevicesSurfaced) {
      this.initialDevicesSurfaced = true;
      for (const device of this.devices.values()) this._emitDiscovery(device);
    }
    this.emit('scanStart');
    return true;
  }

  async stopScan() {
    await this._initPromise;
    if (this.initError) return false;
    if (!this.scanning) return true;
    this.scannerState = 'stopping';
    try {
      await this.adapter.StopDiscovery();
    } catch (error) {
      if (!/No discovery started|NotReady/i.test(String(error?.message || error))) throw error;
    }
    this.scanning = false;
    this.scannerState = 'stopped';
    this.emit('scanStop');
    return true;
  }

  _matchesFilter(device) {
    if (this.uuids.length === 0) return true;
    return device.serviceUuids.some(uuid => this.uuids.includes(normalizeUuid(uuid)));
  }

  _emitDiscovery(device) {
    if (this._matchesFilter(device)) this.emit('discover', device);
  }

  _upsertDevice(path, properties) {
    const address = properties.Address || path.split('/dev_').pop().replaceAll('_', ':');
    const id = addressToId(address);
    let device = this.devices.get(id);
    if (!device) {
      device = new BluezDevice(this, path, properties);
      this.devices.set(id, device);
    } else {
      device.path = path;
      device.updateProperties(properties);
    }
    return device;
  }

  async _attachDeviceProperties(device) {
    if (this.devicePropertyListeners.has(device.path)) return;
    const proxy = await this.bus.getProxyObject(BLUEZ_SERVICE, device.path);
    const properties = proxy.getInterface(PROPS_IFACE);
    const listener = (interfaceName, changed) => {
      if (interfaceName !== DEVICE_IFACE) return;
      const values = unwrapDict(changed);
      const stored = this.objects.get(device.path) || {};
      stored[DEVICE_IFACE] = Object.assign(stored[DEVICE_IFACE] || {}, values);
      this.objects.set(device.path, stored);
      device.updateProperties(values);
      if (this.scanning && Object.keys(values).some(key => ADVERTISEMENT_KEYS.has(key))) {
        this._emitDiscovery(device);
      }
    };
    properties.on('PropertiesChanged', listener);
    this.devicePropertyListeners.set(device.path, { properties, listener });
    device.proxy = proxy;
  }

  _onInterfacesAdded(path, interfaces) {
    const unwrapped = {};
    for (const [name, properties] of Object.entries(interfaces || {})) {
      unwrapped[name] = unwrapDict(properties);
    }
    this.objects.set(path, Object.assign(this.objects.get(path) || {}, unwrapped));
    if (unwrapped[DEVICE_IFACE] && path.startsWith(`${this.adapterPath}/`)) {
      const device = this._upsertDevice(path, unwrapped[DEVICE_IFACE]);
      this._attachDeviceProperties(device).catch(error => this.emit('error', error));
      if (this.scanning) this._emitDiscovery(device);
    }
  }

  _onInterfacesRemoved(path, interfaces) {
    const stored = this.objects.get(path);
    if (stored) {
      for (const name of interfaces || []) delete stored[name];
      if (Object.keys(stored).length === 0) this.objects.delete(path);
    }
    if ((interfaces || []).includes(DEVICE_IFACE)) {
      const listener = this.devicePropertyListeners.get(path);
      if (listener) listener.properties.off('PropertiesChanged', listener.listener);
      this.devicePropertyListeners.delete(path);
      const device = [...this.devices.values()].find(candidate => candidate.path === path);
      if (device) {
        device.handleRemoved();
        this.devices.delete(device.id);
      }
    }
  }

  async removeDevice(device) {
    await this._initPromise;
    const current = this.objects.get(device.path)?.[DEVICE_IFACE] || {};
    if (Object.keys(current).length === 0) return false;
    if (current.Paired) throw new Error(`refusing to remove paired BlueZ device ${device.address}`);
    await this.adapter.RemoveDevice(device.path);
    return true;
  }

  servicesFor(devicePath) {
    const prefix = `${devicePath}/`;
    const result = [];
    for (const [path, interfaces] of this.objects) {
      if (path.startsWith(prefix) && interfaces[GATT_SERVICE_IFACE]) {
        result.push({ path, properties: interfaces[GATT_SERVICE_IFACE] });
      }
    }
    return result;
  }

  characteristicsFor(servicePath) {
    const prefix = `${servicePath}/`;
    const result = [];
    for (const [path, interfaces] of this.objects) {
      if (path.startsWith(prefix) && interfaces[GATT_CHAR_IFACE]) {
        result.push({ path, properties: interfaces[GATT_CHAR_IFACE] });
      }
    }
    return result;
  }

  descriptorsFor(characteristicPath) {
    const prefix = `${characteristicPath}/`;
    const result = [];
    for (const [path, interfaces] of this.objects) {
      if (path.startsWith(prefix) && interfaces[GATT_DESC_IFACE]) {
        result.push({ path, properties: interfaces[GATT_DESC_IFACE] });
      }
    }
    return result;
  }
}

class BluezDevice extends EventEmitter {
  constructor(scanner, path, properties) {
    super();
    this.scanner = scanner;
    this.path = path;
    this.services = new Map();
    this.busy = false;
    this.connected = false;
    this.connecting = false;
    this.state = 'disconnected';
    this.mtu = 20;
    this._connectWaiter = null;
    this.notificationCharacteristics = new Set();
    this.updateProperties(properties);
    const self = this;
    this.peripheral = {
      id: this.id,
      uuid: this.uuid,
      get state() { return self.state; },
      cancelConnect: () => this.cancelConnect(),
      disconnectAsync: () => this.disconnect(),
    };
  }

  updateProperties(properties) {
    this.properties = Object.assign(this.properties || {}, properties || {});
    this.address = String(this.properties.Address || '').toUpperCase();
    this.id = addressToId(this.address);
    this.uuid = this.id;
    this.name = this.properties.Name || this.properties.Alias || this.name;
    this.addressType = this.properties.AddressType || 'unknown';
    this.connectable = this.properties.Blocked !== true;
    if (typeof this.properties.RSSI === 'number') this.rssi = this.properties.RSSI;
    this.serviceUuids = (this.properties.UUIDs || []).map(normalizeUuid);
    this.manufacturerData = buildManufacturerData(this.properties.ManufacturerData);
    const wasActive = this.connected || this.connecting;
    this.connected = !!this.properties.Connected;
    if (this.connected) this.state = 'connected';
    if (this.connected && this.properties.ServicesResolved && this._connectWaiter) {
      this._connectWaiter.resolve(true);
      this._connectWaiter = null;
    }
    if ('Connected' in (properties || {}) && !this.connected && wasActive) this._emitDisconnected();
  }

  checkBusy() {
    if (this.busy) throw new Error('BluezDevice is busy');
    this.busy = true;
    return true;
  }

  resetBusy() {
    this.busy = false;
    return false;
  }

  async _ensureProxy() {
    if (!this.proxy) this.proxy = await this.scanner.bus.getProxyObject(BLUEZ_SERVICE, this.path);
    return this.proxy;
  }

  async _readDeviceProperties() {
    const proxy = await this._ensureProxy();
    const properties = proxy.getInterface(PROPS_IFACE);
    this.updateProperties(unwrapDict(await properties.GetAll(DEVICE_IFACE)));
  }

  async connect(timeoutSeconds = 10) {
    await this._readDeviceProperties();
    if (this.connected && this.properties.ServicesResolved) return true;
    this.connecting = true;
    this.state = 'connecting';
    const proxy = await this._ensureProxy();
    const device = proxy.getInterface(DEVICE_IFACE);
    let timer;
    const ready = new Promise((resolve, reject) => {
      this._connectWaiter = { resolve, reject };
    });
    try {
      await Promise.race([
        (async () => {
          await device.Connect();
          await this._readDeviceProperties();
          if (!(this.connected && this.properties.ServicesResolved)) await ready;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`BlueZ connection timed out after ${timeoutSeconds}s`)),
            timeoutSeconds * 1000,
          );
        }),
      ]);
      this.connected = true;
      this.connecting = false;
      this.state = 'connected';
      this.emit('connected');
      return true;
    } catch (error) {
      this.connected = false;
      this.connecting = false;
      this.state = 'error';
      throw error;
    } finally {
      clearTimeout(timer);
      this._connectWaiter = null;
    }
  }

  async cancelConnect() {
    return this.disconnect();
  }

  async disconnect() {
    const wasActive = this.connected || this.connecting;
    const refreshUnpairedCache = this.properties.Paired !== true;
    try {
      const proxy = await this._ensureProxy();
      await proxy.getInterface(DEVICE_IFACE).Disconnect();
    } catch (error) {
      if (!/NotConnected|not connected|Does Not Exist/i.test(String(error?.message || error))) throw error;
    } finally {
      const shouldEmit = wasActive && this.state !== 'disconnected';
      this.connected = false;
      this.connecting = false;
      this.state = 'disconnected';
      this.services = new Map();
      for (const characteristic of this.notificationCharacteristics) characteristic.cleanup();
      this.notificationCharacteristics.clear();
      if (shouldEmit) this.emit('disconnected');
    }
    if (refreshUnpairedCache) {
      try {
        const removed = await this.scanner.removeDevice(this);
        if (removed) console.log(`[Bluetooth][BlueZ] Removed disconnected unpaired cache for ${this.address}`);
      } catch (error) {
        console.warn(`[Bluetooth][BlueZ] Could not refresh disconnected cache for ${this.address}: ${error.message}`);
      }
    }
    return true;
  }

  _emitDisconnected() {
    this.connected = false;
    this.connecting = false;
    this.state = 'disconnected';
    this.services = new Map();
    for (const characteristic of this.notificationCharacteristics) characteristic.cleanup();
    this.notificationCharacteristics.clear();
    if (this._connectWaiter) {
      this._connectWaiter.reject(new Error('BlueZ device disconnected during connection'));
      this._connectWaiter = null;
    }
    this.emit('disconnected');
  }

  handleRemoved() {
    const wasActive = this.connected || this.connecting;
    this.proxy = null;
    if (wasActive) {
      this._emitDisconnected();
    } else {
      this.state = 'disconnected';
      this.services = new Map();
      for (const characteristic of this.notificationCharacteristics) characteristic.cleanup();
      this.notificationCharacteristics.clear();
    }
  }

  async refreshDevice() {
    return this.scanner.removeDevice(this);
  }

  async discoverServices(serviceUuids = []) {
    await this.scanner.refreshObjects();
    const wanted = serviceUuids.map(normalizeUuid);
    this.services = new Map();
    for (const entry of this.scanner.servicesFor(this.path)) {
      const uuid = normalizeUuid(entry.properties.UUID);
      if (wanted.length === 0 || wanted.includes(uuid)) {
        const service = new BluezService(this, entry.path, entry.properties);
        this.services.set(service.getUUID(), service);
      }
    }
    return this.services;
  }

  async discoverAll() {
    await this.discoverServices();
    for (const service of this.services.values()) await service.discoverCharacteristics();
    return this.services;
  }

  async readCharacteristics() {
    for (const service of this.services.values()) await service.readCharacteristics();
    return true;
  }

  toJSON(asObject = false) {
    const result = {
      id: this.id,
      uuid: this.uuid,
      name: this.name,
      address: this.address,
      addressType: this.addressType,
      connectable: this.connectable,
      rssi: this.rssi,
      mtu: this.mtu,
    };
    return asObject ? result : JSON.stringify(result);
  }

  toString() {
    return `${this.address} ${this.name || ''}`.trim();
  }
}

class BluezService {
  constructor(device, path, properties) {
    this.device = device;
    this.path = path;
    this.uuid = normalizeUuid(properties.UUID);
    this.name = this.uuid;
    this.type = properties.Primary ? 'primary' : 'secondary';
    this.includedServiceUuids = [];
    this.characteristics = new Map();
  }

  getUUID() { return this.uuid; }

  async discoverCharacteristics() {
    await this.device.scanner.refreshObjects();
    this.characteristics = new Map();
    for (const entry of this.device.scanner.characteristicsFor(this.path)) {
      const characteristic = new BluezCharacteristic(this.device, entry.path, entry.properties);
      this.characteristics.set(characteristic.getUUID(), characteristic);
    }
    return this.characteristics;
  }

  async readCharacteristics() {
    if (this.characteristics.size === 0) await this.discoverCharacteristics();
    for (const characteristic of this.characteristics.values()) {
      if (characteristic.properties.includes('read')) await characteristic.read();
    }
    return this.characteristics;
  }

  toJSON(asObject = false) {
    const result = { uuid: this.uuid, name: this.name, type: this.type };
    return asObject ? result : JSON.stringify(result);
  }

  toString() { return this.uuid; }
}

class BluezCharacteristic extends EventEmitter {
  constructor(device, path, properties) {
    super();
    this.device = device;
    this.path = path;
    this.uuid = normalizeUuid(properties.UUID);
    this.name = this.uuid;
    this.type = 'characteristic';
    this.properties = flagsToProperties(properties.Flags);
    this.isReading = false;
    this.descriptors = new Map();
    this._notification = null;
  }

  getUUID() { return this.uuid; }

  async _proxy() {
    return this.device.scanner.bus.getProxyObject(BLUEZ_SERVICE, this.path);
  }

  async read() {
    if (!this.properties.includes('read')) return undefined;
    this.device.checkBusy();
    this.isReading = true;
    try {
      const proxy = await this._proxy();
      this.lastValue = bufferFrom(await proxy.getInterface(GATT_CHAR_IFACE).ReadValue({}));
      return this.lastValue;
    } finally {
      this.isReading = false;
      this.device.resetBusy();
    }
  }

  async write(data, withoutResponse) {
    if (!this.properties.includes('write') && !this.properties.includes('writeWithoutResponse')) return false;
    this.device.checkBusy();
    try {
      const proxy = await this._proxy();
      const options = { type: new this.device.scanner.dbus.Variant('s', withoutResponse ? 'command' : 'request') };
      await proxy.getInterface(GATT_CHAR_IFACE).WriteValue(Buffer.from(data), options);
      return true;
    } finally {
      this.device.resetBusy();
    }
  }

  async subscribe() {
    const proxy = await this._proxy();
    const characteristic = proxy.getInterface(GATT_CHAR_IFACE);
    const properties = proxy.getInterface(PROPS_IFACE);
    if (!this._notification) {
      const listener = (interfaceName, changed) => {
        if (interfaceName !== GATT_CHAR_IFACE) return;
        const values = unwrapDict(changed);
        if ('Value' in values) {
          this.lastValue = bufferFrom(values.Value);
          this.emit('dataRead', this.lastValue);
        }
      };
      properties.on('PropertiesChanged', listener);
      this._notification = { properties, listener };
      this.device.notificationCharacteristics?.add(this);
    }
    await characteristic.StartNotify();
  }

  cleanup() {
    if (this._notification) {
      this._notification.properties.off('PropertiesChanged', this._notification.listener);
      this._notification = null;
    }
  }

  async discoverDescriptors() {
    await this.device.scanner.refreshObjects();
    this.descriptors = new Map();
    for (const entry of this.device.scanner.descriptorsFor(this.path)) {
      const descriptor = new BluezDescriptor(this.device, entry.path, entry.properties);
      this.descriptors.set(descriptor.uuid, descriptor);
    }
    return this.descriptors;
  }

  toJSON(asObject = false) {
    const result = { uuid: this.uuid, properties: this.properties, value: this.lastValue?.toString('hex') };
    return asObject ? result : JSON.stringify(result);
  }

  toString() { return this.uuid; }
}

class BluezDescriptor {
  constructor(device, path, properties) {
    this.device = device;
    this.path = path;
    this.uuid = normalizeUuid(properties.UUID);
    this.name = this.uuid;
    this.type = 'descriptor';
  }

  async _proxy() {
    return this.device.scanner.bus.getProxyObject(BLUEZ_SERVICE, this.path);
  }

  async readValue() {
    const proxy = await this._proxy();
    this.lastValue = bufferFrom(await proxy.getInterface(GATT_DESC_IFACE).ReadValue({}));
    return this.lastValue;
  }

  async writeValue(data) {
    const proxy = await this._proxy();
    await proxy.getInterface(GATT_DESC_IFACE).WriteValue(Buffer.from(data), {});
    this.lastValue = Buffer.from(data);
  }

  toJSON(asObject = false) {
    const result = { uuid: this.uuid, value: this.lastValue?.toString('hex') };
    return asObject ? result : JSON.stringify(result);
  }

  toString() { return this.uuid; }
}

class BluezBluetoothLeService extends EventEmitter {
  constructor(uuids, options = {}) {
    super();
    this.btDevices = new Map();
    this.scanner = new BluezScanner(uuids, options);
    this.scanner.on('ready', () => this.emit('ready'));
    this.scanner.on('discover', device => this._onDiscover(device));
    this.scanner.on('scanStart', () => this.emit('scanStart'));
    this.scanner.on('scanStop', () => this.emit('scanStop'));
    this.scanner.on('error', error => console.error('[Bluetooth][BlueZ] scanner error:', error));
  }

  startScan(passive = false) { return this.scanner.startScan(passive); }
  stopScan() { return this.scanner.stopScan(); }
  isScanning() { return this.scanner.getState() === 'scanning'; }
  forgetDevice(id) { this.btDevices.delete(id); }

  _onDiscover(device) {
    const existing = this.btDevices.get(device.id);
    if (existing) {
      existing.updateFromDevice(device);
      this.emit('advertisement', existing);
      return;
    }
    const ttDevice = TTBluetoothDevice.createFromDevice(device, this.scanner);
    this.btDevices.set(device.id, ttDevice);
    this.emit('discover', ttDevice);
  }
}

class BluezTTLockClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bleService = null;
    this.uuids = options.uuids || ['1910', '00001910-0000-1000-8000-00805f9b34fb'];
    this.lockDevices = new Map();
    this.lockData = new Map();
    this.scanning = false;
    this.monitoring = false;
    this.adapterReady = false;
    if (options.lockData) this.setLockData(options.lockData);
  }

  async prepareBTService() {
    if (this.bleService !== null) return true;
    this.bleService = new BluezBluetoothLeService(this.uuids, {
      adapterId: selectedAdapterId(),
    });
    this.bleService.on('ready', () => {
      this.adapterReady = true;
      this.emit('ready');
    });
    this.bleService.on('scanStart', this.onScanStart.bind(this));
    this.bleService.on('scanStop', this.onScanStop.bind(this));
    this.bleService.on('discover', this.onScanResult.bind(this));
    this.bleService.on('advertisement', device => {
      const lock = this.lockDevices.get(device.address);
      if (lock) this.emit('lockAdvertisement', lock);
    });
    for (let counter = 0; counter < 20 && !this.adapterReady; counter++) await sleep(250);
    return this.adapterReady;
  }

  stopBTService() {
    if (this.bleService) this.stopScanLock();
    this.bleService = null;
    return true;
  }

  async startScanLock() {
    if (this.bleService && !this.scanning && !this.monitoring) {
      this.scanning = true;
      this.scanning = await this.bleService.startScan(false);
      return this.scanning;
    }
    return false;
  }

  async stopScanLock() {
    if (this.bleService && this.isScanning()) return this.bleService.stopScan();
    return true;
  }

  async startMonitor() {
    if (this.bleService && !this.scanning && !this.monitoring) {
      this.monitoring = true;
      this.monitoring = await this.bleService.startScan(true);
      return this.monitoring;
    }
    return false;
  }

  async stopMonitor() {
    if (this.bleService && this.isMonitoring()) return this.bleService.stopScan();
    return false;
  }

  isScanning() {
    return !!(this.bleService?.isScanning() && this.scanning);
  }

  isMonitoring() {
    return !!(this.bleService?.isScanning() && this.monitoring);
  }

  getLockData() {
    return [...this.lockData.values()];
  }

  setLockData(newLockData) {
    this.lockData = new Map();
    for (const lockData of newLockData || []) {
      this.lockData.set(lockData.address, lockData);
      this.lockDevices.get(lockData.address)?.updateLockData(lockData);
    }
  }

  onScanStart() {
    if (this.scanning) this.emit('scanStart');
    else if (this.monitoring) this.emit('monitorStart');
  }

  onScanStop() {
    if (this.scanning) {
      this.emit('scanStop');
      this.scanning = false;
    } else if (this.monitoring) {
      this.emit('monitorStop');
      this.monitoring = false;
    }
  }

  onScanResult(device) {
    if (device.lockType === LockType.UNKNOWN || this.lockDevices.has(device.address)) return;
    const lock = new TTLock(device, this.lockData.get(device.address));
    this.lockDevices.set(device.address, lock);
    lock.on('dataUpdated', updatedLock => {
      const lockData = updatedLock.getLockData();
      if (lockData) {
        this.lockData.set(lockData.address, lockData);
        this.emit('updatedLockData');
      }
    });
    lock.on('lockReset', (address, id) => {
      this.lockData.delete(address);
      this.lockDevices.delete(address);
      this.bleService?.forgetDevice(id);
      this.emit('updatedLockData');
    });
    this.emit('foundLock', lock);
  }
}

module.exports = {
  BluezBluetoothLeService,
  BluezCharacteristic,
  BluezDescriptor,
  BluezDevice,
  BluezScanner,
  BluezService,
  BluezTTLockClient,
  addressToId,
  buildManufacturerData,
  expandUuid,
  flagsToProperties,
  normalizeUuid,
  selectedAdapterId,
  unwrapDict,
  unwrapVariant,
};
