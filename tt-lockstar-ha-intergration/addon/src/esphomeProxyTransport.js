'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');
const { TTBluetoothDevice } = require('ttlock-sdk-js/dist/device/TTBluetoothDevice');
const { TTLock } = require('ttlock-sdk-js/dist/device/TTLock');
const { LockType } = require('ttlock-sdk-js/dist/constant/Lock');
const {
  addressToId,
  normalizeUuid,
} = require('./bluezTransport');
const { HomeAssistantBluetoothFeed } = require('./haBluetoothFeed');

const GATT_PROPERTIES = {
  0x01: 'broadcast',
  0x02: 'read',
  0x04: 'writeWithoutResponse',
  0x08: 'write',
  0x10: 'notify',
  0x20: 'indicate',
  0x40: 'authenticatedSignedWrites',
  0x80: 'extendedProperties',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function propertyMaskToNames(mask) {
  return Object.entries(GATT_PROPERTIES)
    .filter(([bit]) => (Number(mask) & Number(bit)) !== 0)
    .map(([, name]) => name);
}

function buildProxyManufacturerData(data) {
  const result = [];
  for (const [companyId, hex] of Object.entries(data || {})) {
    const id = Number(companyId) & 0xffff;
    result.push(Buffer.concat([
      Buffer.from([id & 0xff, (id >> 8) & 0xff]),
      Buffer.from(hex || '', 'hex'),
    ]));
  }
  return result.length > 0 ? Buffer.concat(result) : Buffer.alloc(0);
}

function inferUnknownBleAddressType(address) {
  const firstOctet = Number.parseInt(String(address || '').split(':')[0], 16);
  if (!Number.isFinite(firstOctet)) return 0;
  // Home Assistant's shared Bluetooth service-info feed omits address_type.
  // A static-random BLE address has its two most-significant bits set. Keep
  // any explicit ESPHome address type authoritative; use this only when the
  // shared feed provides no type at all.
  return (firstOctet & 0xC0) === 0xC0 ? 1 : 0;
}

class EsphomeProxyBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.python = options.python || process.env.TTLOCK_PROXY_PYTHON || 'python3';
    this.script = options.script || path.join(__dirname, 'esphome_proxy_bridge.py');
    this.hosts = options.hosts || process.env.TTLOCK_ESPHOME_PROXY_HOSTS || '';
    this.spawn = options.spawn || spawn;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.ready = false;
  }

  async start(timeoutMs = 15000) {
    if (this.ready) return true;
    if (!this.started) this._spawn();
    let timer;
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = error => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            this.off('ready', onReady);
            this.off('fatal', onError);
          };
          this.on('ready', onReady);
          this.on('fatal', onError);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`ESPHome proxy bridge was not ready after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  _spawn() {
    if (!this.hosts.trim()) throw new Error('TTLOCK_ESPHOME_PROXY_HOSTS is empty');
    this.started = true;
    this.child = this.spawn(this.python, ['-u', this.script], {
      env: Object.assign({}, process.env, { TTLOCK_ESPHOME_PROXY_HOSTS: this.hosts }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => this._onLine(line));
    this.child.stderr.on('data', data => {
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
        console.error(line);
      }
    });
    this.child.on('error', error => this._onExit(error));
    this.child.on('exit', (code, signal) => {
      this._onExit(new Error(`ESPHome proxy bridge exited (code=${code}, signal=${signal})`));
    });
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error(`[Bluetooth][ESPHome] Invalid bridge output: ${line}`);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'ESPHome proxy request failed'));
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      this.emit('ready', message.proxies || []);
    }
    this.emit(message.type || 'message', message);
  }

  _onExit(error) {
    if (!this.started) return;
    this.started = false;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('fatal', error);
  }

  request(action, payload = {}, timeoutMs = 15000) {
    if (!this.child || !this.started) return Promise.reject(new Error('ESPHome proxy bridge is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ESPHome proxy ${action} request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(Object.assign({ id, action }, payload))}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  noteAdvertisement(device) {
    return this.request('observe', {
      address: device.address,
      address_type: device.address_type,
      rssi: device.rssi,
      source: device.source,
    }, 3000);
  }

  close() {
    if (this.child?.stdin?.writable) this.child.stdin.end();
  }
}

class EsphomeProxyScanner extends EventEmitter {
  constructor(uuids = [], options = {}) {
    super();
    this.uuids = [...new Set(uuids.map(normalizeUuid))];
    this.bridge = options.bridge || new EsphomeProxyBridge(options);
    this.advertisementSource = options.advertisementSource
      || process.env.TTLOCK_ESPHOME_ADVERTISEMENT_SOURCE
      || 'home_assistant';
    this.advertisementFeed = options.advertisementFeed
      || (this.advertisementSource === 'home_assistant'
        ? new HomeAssistantBluetoothFeed(options)
        : null);
    this.devices = new Map();
    this.targetAddresses = new Set();
    this.scannerState = 'unknown';
    this.scanning = false;
    this.initialDevicesSurfaced = false;
    this.bridgeReady = false;
    this.feedReady = this.advertisementFeed === null;
    this.readyEmitted = false;
    this.bridge.on('ready', proxies => {
      this.proxies = proxies;
      this.bridgeReady = true;
      this._maybeReady();
    });
    this.bridge.on('advertisement', event => {
      this._onAdvertisement(event).catch(error => this.emit('error', error));
    });
    this.bridge.on('connection', event => {
      this.devices.get(addressToId(event.address))?.handleConnectionEvent(event);
    });
    this.bridge.on('notification', event => {
      this.devices.get(addressToId(event.address))?.handleNotification(event);
    });
    this.bridge.on('proxy_error', event => {
      console.warn(`[Bluetooth][ESPHome] ${event.proxy?.endpoint || 'proxy'}: ${event.error}`);
    });
    this.bridge.on('fatal', error => {
      this.scannerState = 'unsupported';
      this.emit('error', error);
    });
    if (this.advertisementFeed) {
      this.advertisementFeed.on('ready', () => {
        this.feedReady = true;
        this._maybeReady();
      });
      this.advertisementFeed.on('advertisement', event => {
        this._onAdvertisement(event).catch(error => this.emit('error', error));
      });
      this.advertisementFeed.on('fatal', error => {
        this.scannerState = 'unsupported';
        this.emit('error', error);
      });
    }
    const starts = [this.bridge.start()];
    if (this.advertisementFeed) starts.push(this.advertisementFeed.start());
    this._initPromise = Promise.all(starts).catch(error => {
      this.scannerState = 'unsupported';
      this.emit('error', error);
      return false;
    });
  }

  _maybeReady() {
    if (this.readyEmitted || !this.bridgeReady || !this.feedReady) return;
    this.readyEmitted = true;
    this.scannerState = 'stopped';
    this.emit('ready');
  }

  getState() { return this.scannerState; }

  setTargetAddresses(addresses) {
    this.targetAddresses = new Set(
      [...addresses].map(address => String(address).toUpperCase()),
    );
  }

  async startScan() {
    await this._initPromise;
    if (!this.bridge.ready) throw new Error('ESPHome proxy bridge is unavailable');
    if (this.scanning) return false;
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
    if (!this.scanning) return true;
    this.scanning = false;
    this.scannerState = 'stopped';
    this.emit('scanStop');
    return true;
  }

  _matchesFilter(device) {
    if (this.targetAddresses.has(String(device.address).toUpperCase())) return true;
    if (this.uuids.length === 0) return true;
    return device.serviceUuids.some(uuid => this.uuids.includes(normalizeUuid(uuid)));
  }

  _emitDiscovery(device) {
    if (this._matchesFilter(device)) this.emit('discover', device);
  }

  async _onAdvertisement(event) {
    const values = event.device || {};
    const id = addressToId(values.address);
    let device = this.devices.get(id);
    if (!device) {
      device = new EsphomeProxyDevice(this, values);
      this.devices.set(id, device);
    } else {
      device.updateAdvertisement(values);
    }
    let proxy = event.proxy;
    const matched = this._matchesFilter(device);
    if (matched && event.transport === 'home_assistant') {
      try {
        const observed = await this.bridge.noteAdvertisement(values);
        proxy = observed?.proxy || values.source || proxy;
      } catch (error) {
        console.warn(
          `[Bluetooth][ESPHome] Could not map Home Assistant advertisement ${device.address} `
          + `to a proxy: ${error.message || error}`,
        );
      }
    }
    device.lastProxy = proxy;
    if (matched) {
      console.log(
        `[Bluetooth][ESPHome] Target advertisement ${device.address} via ${proxy || 'unknown proxy'} `
        + `(RSSI ${device.rssi})`,
      );
    }
    if (this.scanning) this._emitDiscovery(device);
  }

  async refreshDevice(device) {
    return this.bridge.request('clear_cache', { address: device.address }, 10000);
  }
}

class EsphomeProxyDevice extends EventEmitter {
  constructor(scanner, advertisement) {
    super();
    this.scanner = scanner;
    this.services = new Map();
    this.characteristicsByHandle = new Map();
    this.busy = false;
    this.connected = false;
    this.connecting = false;
    this.state = 'disconnected';
    this.mtu = 20;
    this.updateAdvertisement(advertisement);
    const self = this;
    this.peripheral = {
      id: this.id,
      uuid: this.uuid,
      get state() { return self.state; },
      cancelConnect: () => this.cancelConnect(),
      disconnectAsync: () => this.disconnect(),
    };
  }

  updateAdvertisement(advertisement) {
    this.address = String(advertisement.address || this.address || '').toUpperCase();
    this.id = addressToId(this.address);
    this.uuid = this.id;
    this.name = advertisement.name || this.name;
    this.rssi = Number.isFinite(advertisement.rssi) ? advertisement.rssi : this.rssi;
    if (Number.isInteger(advertisement.address_type)) {
      this.addressType = advertisement.address_type;
      this.addressTypeInferred = false;
    } else if (!Number.isInteger(this.addressType)) {
      this.addressType = inferUnknownBleAddressType(this.address);
      this.addressTypeInferred = true;
      console.log(
        `[Bluetooth][ESPHome] Home Assistant omitted address type for ${this.address}; `
        + `using ${this.addressType === 1 ? 'static-random' : 'public'}`,
      );
    }
    this.connectable = true;
    this.serviceUuids = (advertisement.service_uuids || this.serviceUuids || []).map(normalizeUuid);
    this.serviceData = advertisement.service_data || this.serviceData || {};
    this.manufacturerData = buildProxyManufacturerData(
      advertisement.manufacturer_data || this.rawManufacturerData || {},
    );
    this.rawManufacturerData = advertisement.manufacturer_data || this.rawManufacturerData || {};
  }

  checkBusy() {
    if (this.busy) throw new Error('EsphomeProxyDevice is busy');
    this.busy = true;
    return true;
  }

  resetBusy() {
    this.busy = false;
    return false;
  }

  async connect(timeoutSeconds = 10) {
    if (this.connected) return true;
    this.connecting = true;
    this.state = 'connecting';
    try {
      const requestedTimeout = Number(timeoutSeconds);
      // Command-only TTLock sessions request eight seconds. Do not silently
      // stretch that to 18 seconds: an old/weak connection attempt can consume
      // the lock's short BLE command window before the bounded retry starts.
      // Full metadata sessions still pass their existing longer timeout.
      const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.max(requestedTimeout, 8)
        : 8;
      const result = await this.scanner.bridge.request('connect', {
        address: this.address,
        address_type: this.addressType,
        timeout,
      // aioesphomeapi can spend another 20 seconds draining a failed ESPHome
      // GATT attempt. Keep the request alive long enough for the bridge's next
      // proxy candidate to return success, while remaining inside the manager's
      // 45/55-second command/full-session outer bounds.
      }, Math.min(((timeout * 4) + 5) * 1000, 50000));
      this.connected = true;
      this.connecting = false;
      this.state = 'connected';
      this.mtu = Math.max(20, Number(result?.mtu) || 20);
      this.proxyName = result?.proxy;
      console.log(`[Bluetooth][ESPHome] Connected ${this.address} through ${this.proxyName || 'unknown proxy'} (MTU ${this.mtu})`);
      this.emit('connected');
      return true;
    } catch (error) {
      this.connected = false;
      this.connecting = false;
      this.state = 'error';
      throw error;
    }
  }

  cancelConnect() { return this.disconnect(); }

  async disconnect() {
    const wasActive = this.connected || this.connecting;
    try {
      if (wasActive) {
        await this.scanner.bridge.request('disconnect', { address: this.address, timeout: 5 }, 8000);
      }
    } catch (error) {
      if (!/not connected/i.test(String(error?.message || error))) throw error;
    } finally {
      this.connected = false;
      this.connecting = false;
      this.state = 'disconnected';
      this.services = new Map();
      this.characteristicsByHandle.clear();
      if (wasActive) this.emit('disconnected');
    }
    return true;
  }

  handleConnectionEvent(event) {
    if (event.connected) {
      this.connected = true;
      this.connecting = false;
      this.state = 'connected';
      this.mtu = Math.max(20, Number(event.mtu) || this.mtu);
      return;
    }
    const wasActive = this.connected || this.connecting;
    this.connected = false;
    this.connecting = false;
    this.state = 'disconnected';
    this.services = new Map();
    this.characteristicsByHandle.clear();
    if (wasActive) this.emit('disconnected');
  }

  handleNotification(event) {
    const characteristic = this.characteristicsByHandle.get(Number(event.handle));
    if (!characteristic) return;
    characteristic.lastValue = Buffer.from(event.data || '', 'hex');
    characteristic.emit('dataRead', characteristic.lastValue);
  }

  refreshDevice() { return this.scanner.refreshDevice(this); }

  async discoverServices(serviceUuids = []) {
    const wanted = serviceUuids.map(normalizeUuid);
    const services = await this.scanner.bridge.request('services', { address: this.address }, 15000);
    this.services = new Map();
    this.characteristicsByHandle.clear();
    for (const raw of services || []) {
      const uuid = normalizeUuid(raw.uuid);
      if (wanted.length === 0 || wanted.includes(uuid)) {
        const service = new EsphomeProxyService(this, raw);
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
      proxy: this.proxyName || this.lastProxy,
    };
    return asObject ? result : JSON.stringify(result);
  }

  toString() { return `${this.address} ${this.name || ''}`.trim(); }
}

class EsphomeProxyService {
  constructor(device, raw) {
    this.device = device;
    this.raw = raw;
    this.uuid = normalizeUuid(raw.uuid);
    this.name = this.uuid;
    this.type = 'primary';
    this.includedServiceUuids = [];
    this.characteristics = new Map();
  }

  getUUID() { return this.uuid; }

  async discoverCharacteristics() {
    this.characteristics = new Map();
    for (const raw of this.raw.characteristics || []) {
      const characteristic = new EsphomeProxyCharacteristic(this.device, raw);
      this.characteristics.set(characteristic.getUUID(), characteristic);
      this.device.characteristicsByHandle.set(characteristic.handle, characteristic);
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

class EsphomeProxyCharacteristic extends EventEmitter {
  constructor(device, raw) {
    super();
    this.device = device;
    this.raw = raw;
    this.handle = Number(raw.handle);
    this.uuid = normalizeUuid(raw.uuid);
    this.name = this.uuid;
    this.type = 'characteristic';
    this.properties = propertyMaskToNames(raw.properties);
    this.isReading = false;
    this.descriptors = new Map();
    this.subscribed = false;
  }

  getUUID() { return this.uuid; }

  async read() {
    if (!this.properties.includes('read')) return undefined;
    this.device.checkBusy();
    this.isReading = true;
    try {
      const hex = await this.device.scanner.bridge.request('read', {
        address: this.device.address,
        handle: this.handle,
      });
      this.lastValue = Buffer.from(hex || '', 'hex');
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
      await this.device.scanner.bridge.request('write', {
        address: this.device.address,
        handle: this.handle,
        data: Buffer.from(data).toString('hex'),
        response: !withoutResponse,
      });
      return true;
    } finally {
      this.device.resetBusy();
    }
  }

  async writeFragments(fragments, withoutResponse, delayMs = 20) {
    if (!this.properties.includes('write') && !this.properties.includes('writeWithoutResponse')) return false;
    this.device.checkBusy();
    try {
      const data = fragments.map(fragment => Buffer.from(fragment).toString('hex'));
      const written = await this.device.scanner.bridge.request('write_fragments', {
        address: this.device.address,
        handle: this.handle,
        data,
        response: !withoutResponse,
        delay_ms: delayMs,
      });
      return Number(written) === data.length;
    } finally {
      this.device.resetBusy();
    }
  }

  async subscribe() {
    if (!this.subscribed) {
      await this.device.scanner.bridge.request('subscribe', {
        address: this.device.address,
        handle: this.handle,
      });
      this.subscribed = true;
    }
    return true;
  }

  cleanup() {
    this.subscribed = false;
  }

  async discoverDescriptors() {
    this.descriptors = new Map();
    for (const raw of this.raw.descriptors || []) {
      const descriptor = new EsphomeProxyDescriptor(this.device, raw);
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

class EsphomeProxyDescriptor {
  constructor(device, raw) {
    this.device = device;
    this.handle = Number(raw.handle);
    this.uuid = normalizeUuid(raw.uuid);
    this.name = this.uuid;
    this.type = 'descriptor';
  }

  async readValue() {
    const hex = await this.device.scanner.bridge.request('read_descriptor', {
      address: this.device.address,
      handle: this.handle,
    });
    this.lastValue = Buffer.from(hex || '', 'hex');
    return this.lastValue;
  }

  async writeValue(data) {
    await this.device.scanner.bridge.request('write_descriptor', {
      address: this.device.address,
      handle: this.handle,
      data: Buffer.from(data).toString('hex'),
    });
    this.lastValue = Buffer.from(data);
  }

  toJSON(asObject = false) {
    const result = { uuid: this.uuid, value: this.lastValue?.toString('hex') };
    return asObject ? result : JSON.stringify(result);
  }

  toString() { return this.uuid; }
}

class EsphomeProxyBluetoothLeService extends EventEmitter {
  constructor(uuids, options = {}) {
    super();
    this.btDevices = new Map();
    this.scanner = new EsphomeProxyScanner(uuids, options);
    this.scanner.on('ready', () => this.emit('ready'));
    this.scanner.on('discover', device => this._onDiscover(device));
    this.scanner.on('scanStart', () => this.emit('scanStart'));
    this.scanner.on('scanStop', () => this.emit('scanStop'));
    this.scanner.on('error', error => console.error('[Bluetooth][ESPHome] scanner error:', error));
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

class EsphomeProxyTTLockClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bleService = null;
    this.uuids = options.uuids || ['1910', '00001910-0000-1000-8000-00805f9b34fb'];
    this.lockDevices = new Map();
    this.lockData = new Map();
    this.scanning = false;
    this.monitoring = false;
    this.adapterReady = false;
    this.options = options;
    if (options.lockData) this.setLockData(options.lockData);
  }

  async prepareBTService() {
    if (this.bleService !== null) return true;
    this.bleService = new EsphomeProxyBluetoothLeService(this.uuids, this.options);
    this.bleService.scanner.setTargetAddresses(this.lockData.keys());
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
    for (let counter = 0; counter < 60 && !this.adapterReady; counter++) await sleep(250);
    return this.adapterReady;
  }

  stopBTService() {
    if (this.bleService) this.stopScanLock();
    this.bleService?.scanner?.bridge?.close();
    this.bleService?.scanner?.advertisementFeed?.close();
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

  isScanning() { return !!(this.bleService?.isScanning() && this.scanning); }
  isMonitoring() { return !!(this.bleService?.isScanning() && this.monitoring); }
  getLockData() { return [...this.lockData.values()]; }

  setLockData(newLockData) {
    this.lockData = new Map();
    for (const lockData of newLockData || []) {
      this.lockData.set(lockData.address, lockData);
      this.lockDevices.get(lockData.address)?.updateLockData(lockData);
    }
    this.bleService?.scanner?.setTargetAddresses(this.lockData.keys());
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
  EsphomeProxyBluetoothLeService,
  EsphomeProxyBridge,
  EsphomeProxyCharacteristic,
  EsphomeProxyDescriptor,
  EsphomeProxyDevice,
  EsphomeProxyScanner,
  EsphomeProxyService,
  EsphomeProxyTTLockClient,
  buildProxyManufacturerData,
  inferUnknownBleAddressType,
  propertyMaskToNames,
};
