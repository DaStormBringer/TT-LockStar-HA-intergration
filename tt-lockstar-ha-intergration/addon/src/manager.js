'use strict';

const EventEmitter = require('events');
const store = require("./store");
const { TTLockClient, AudioManage, LockedStatus, LogOperate, LogOperateCategory, LogOperateNames } = require("ttlock-sdk-js");
const { DoorState, OperationState, inferLatestDoorState, inferLatestOperationState } = require('./operationState');
const { connectWithPolicy, isConnectionRetrySafe } = require('./connectionPolicy');

const DEADBOLT_LOCK_RECORD_TYPES = LogOperateCategory.LOCK.filter(
  recordType => recordType !== LogOperate.DOOR_SENSOR_LOCK,
);
const DEADBOLT_UNLOCK_RECORD_TYPES = LogOperateCategory.UNLOCK.filter(
  recordType => recordType !== LogOperate.DOOR_SENSOR_UNLOCK,
);

// Global console.log wrapper to suppress verbose SDK logs unless TTLOCK_DEBUG_COMM is enabled
const originalConsoleLog = console.log;
console.log = function (...args) {
  if (process.env.TTLOCK_DEBUG_COMM !== '1') {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && (
      firstArg.startsWith('=========') ||
      firstArg.startsWith('BLE Device') ||
      firstArg.startsWith('Sending command:') ||
      firstArg.startsWith('Received response:') ||
      firstArg.startsWith('Peripheral connect') ||
      firstArg.startsWith('Device emiting') ||
      firstArg.startsWith('Lock waiting') ||
      firstArg.startsWith('Connect allready') ||
      firstArg.startsWith('Lock connect') ||
      firstArg.startsWith('[MonkeyPatch]')
    )) {
      return;
    }
  }
  originalConsoleLog.apply(console, args);
};

// Monkey patch ttlock-sdk-js connection timeouts to handle weak BLE signals / slower HA BT adapters
try {
  const { NobleDevice } = require("ttlock-sdk-js/dist/scanner/noble/NobleDevice");
  const originalNobleConnect = NobleDevice.prototype.connect;
  NobleDevice.prototype.connect = function (timeout) {
    const requestedTimeout = Number(timeout);
    const finalTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : 40;
    console.log(`[MonkeyPatch] NobleDevice.connect: using timeout ${finalTimeout}s`);
    return originalNobleConnect.call(this, finalTimeout);
  };

  const { TTLock } = require("ttlock-sdk-js/dist/device/TTLock");
  const originalTTLockConnect = TTLock.prototype.connect;
  TTLock.prototype.connect = function (skipDataRead = false, timeout) {
    const requestedTimeout = Number(timeout);
    const defaultTimeout = skipDataRead ? 8 : 45;
    const finalTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? (skipDataRead ? requestedTimeout : Math.max(requestedTimeout, 45))
      : defaultTimeout;
    console.log(`[MonkeyPatch] TTLock.connect: using timeout ${finalTimeout}s`);
    return originalTTLockConnect.call(this, skipDataRead, finalTimeout);
  };

  const { SetAdminKeyboardPwdCommand } = require("ttlock-sdk-js/dist/api/Commands/SetAdminKeyboardPwdCommand");
  const originalProcessData = SetAdminKeyboardPwdCommand.prototype.processData;
  SetAdminKeyboardPwdCommand.prototype.processData = function () {
    if (originalProcessData) {
      originalProcessData.call(this);
    }
    if (this.commandResponse === 0) {
      console.log("[MonkeyPatch] SetAdminKeyboardPwdCommand: Mapping response code 0 (ERROR_NONE) to 1 (SUCCESS)");
      this.commandResponse = 1;
    }
  };
} catch (err) {
  console.error("Failed to apply ttlock-sdk-js monkey patches:", err);
}

const ScanType = Object.freeze({
  NONE: 0,
  AUTOMATIC: 1,
  MANUAL: 2
});

const SCAN_MAX = 3;

/**
 * Sleep for
 * @param ms miliseconds
 */
async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
/**
 * Events:
 * - lockListChanged - when a lock was found during scanning
 * - lockPaired - a lock was paired
 * - lockConnected - a connetion to a lock was estabilisehed
 * - lockLock - a lock was locked
 * - lockUnlock - a lock was unlocked
 * - lockStateUnknown - operation evidence cannot confirm the deadbolt position
 * - doorStateUpdated - the magnetic door contact changed
 * - scanStart - scanning has started
 * - scanStop - scanning has stopped
 */
class Manager extends EventEmitter {
  constructor() {
    super();
    this.startupStatus = -1;
    this.client = undefined;
    this.scanning = false;
    this.interacting = false;
    this.lockMutexes = new Map();
    /** @type {NodeJS.Timeout} */
    this.scanTimer = undefined;
    this.scanCounter = 0;
    /** @type {Map<string, import('ttlock-sdk-js').TTLock>} Locks that are paired and were seen during the BLE scan */
    this.pairedLocks = new Map();
    /** @type {Map<string, import('ttlock-sdk-js').TTLock>} Locks that are pairable and were seen during the BLE scan */
    this.newLocks = new Map();
    /** @type {Set<string>} Locks found during scan that we need to connect to at least once to get their information */
    this.connectQueue = new Set();
    /** @type {'none'|'noble'} */
    this.gateway = 'none';
    this.gateway_host = "";
    this.gateway_port = 0;
    this.gateway_key = "";
    this.gateway_user = "";
    this.gateway_pass = "";
    this.processingLocks = new Set();
  }

  async init() {
    if (typeof this.client == "undefined") {
      try {
        let clientOptions = {}

        if (this.gateway == "noble") {
          clientOptions.scannerType = "noble-websocket";
          clientOptions.scannerOptions = {
            websocketHost: this.gateway_host,
            websocketPort: this.gateway_port,
            websocketAesKey: this.gateway_key,
            websocketUsername: this.gateway_user,
            websocketPassword: this.gateway_pass
          }
        }

        this.client = new TTLockClient(clientOptions);
        const migrated = await store.migrateDeadboltStateSchema(2);
        if (migrated) {
          console.warn('[Manager] Cleared legacy inferred deadbolt state; door-contact records are now tracked separately');
        }
        this.updateClientLockDataFromStore();

        this.client.on("ready", () => {
          // should not trigger if prepareBTService emits it
          // but useful for when websocket reconnects
          // disable it for now as the reconnection won't re-trigger ready
          // this.startScan(ScanType.AUTOMATIC);
          this.client.startMonitor();
        });
        this.client.on("foundLock", this._onFoundLock.bind(this));
        this.client.on("scanStart", this._onScanStarted.bind(this));
        this.client.on("scanStop", this._onScanStopped.bind(this));
        this.client.on("monitorStart", () => console.log("Monitor started"));
        this.client.on("monitorStop", () => console.log("Monitor stopped"));
        this.client.on("updatedLockData", this._onUpdatedLockData.bind(this));
        const adapterReady = await this.client.prepareBTService();
        if (adapterReady) {
          this.startupStatus = 0;
        } else {
          this.startupStatus = 1;
        }
      } catch (error) {
        console.log(error);
        this.startupStatus = 1;
      }
    }
  }

  updateClientLockDataFromStore() {
    const lockData = store.getLockData();
    this.client.setLockData(lockData);
  }

  setNobleGateway(gateway_host, gateway_port, gateway_key, gateway_user, gateway_pass) {
    this.gateway = "noble";
    this.gateway_host = gateway_host;
    this.gateway_port = gateway_port;
    this.gateway_key = gateway_key;
    this.gateway_user = gateway_user;
    this.gateway_pass = gateway_pass;
  }

  getStartupStatus() {
    return this.startupStatus;
  }

  async startScan() {
    if (!this.scanning) {
      await this.client.stopMonitor();
      const res = await this.client.startScanLock();
      if (res == true) {
        this._scanTimer();
      }
      return res;
    }
    return false;
  }

  async stopScan() {
    if (this.scanning) {
      if (typeof this.scanTimer != "undefined") {
        clearTimeout(this.scanTimer);
        this.scanTimer = undefined;
      }
      return await this.client.stopScanLock();
    }
    return false;
  }

  getIsScanning() {
    return this.scanning;
  }

  getPairedVisible() {
    return this.pairedLocks;
  }

  getNewVisible() {
    return this.newLocks;
  }

  /**
   * Init a new lock
   * @param {string} address MAC address
   */
  async initLock(address) {
    const lock = this.newLocks.get(address);
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        throw new Error("Failed to connect to lock. Ensure it is close enough and keypad is awake.");
      }
      try {
        let res = await lock.initLock();
        if (res != false) {
          this.pairedLocks.set(lock.getAddress(), lock);
          this.newLocks.delete(lock.getAddress());
          this._bindLockEvents(lock);
          this.emit("lockPaired", lock);
          return true;
        }
        throw new Error("Failed to initialize lock (invalid response).");
      } catch (error) {
        console.error(error);
        throw error;
      } finally {
        await this.disconnectLock(address);
      }
    }
    throw new Error("Lock not found in scanned list.");
  }

  async disconnectLock(address) {
    const lock = this.pairedLocks.get(address);
    this.interacting = false;
    if (typeof lock != "undefined" && lock.isConnected()) {
      try {
        console.log(`[Manager] Explicitly disconnecting lock ${address}`);
        await lock.disconnect();
      } catch (error) {
        console.error(`[Manager] Error explicitly disconnecting lock ${address}:`, error);
        this.client.startMonitor();
      }
    } else {
      this.client.startMonitor();
    }
    const mutex = this.lockMutexes.get(address);
    if (mutex) {
      this.lockMutexes.delete(address);
      mutex.resolve();
    }
  }

  async unlockLock(address) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      const result = await this._executeWithRetry(lock, "unlock", async () => {
        const res = await lock.unlock();
        if (res && typeof lock.getLastOperationTimestamp === "function") {
          const timestamp = lock.getLastOperationTimestamp();
          if (typeof timestamp !== "undefined") {
            this.emit("lockTimeUpdated", lock, timestamp);
          }
        }
        return res;
      });
      if (result) await store.setLockData(this.client.getLockData());
      return result;
    }
    return false;
  }

  async lockLock(address) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      const result = await this._executeWithRetry(lock, "lock", async () => {
        const res = await lock.lock();
        if (res && typeof lock.getLastOperationTimestamp === "function") {
          const timestamp = lock.getLastOperationTimestamp();
          if (typeof timestamp !== "undefined") {
            this.emit("lockTimeUpdated", lock, timestamp);
          }
        }
        return res;
      });
      if (result) await store.setLockData(this.client.getLockData());
      return result;
    }
    return false;
  }

  async setAutoLock(address, value) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const res = await lock.setAutoLockTime(value);
        this.emit("lockUpdated", lock);
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async getLockTime(address) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const time = await lock.getLockTime();
        this.emit("lockTimeUpdated", lock, time);
        return time;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async syncLockTime(address) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const result = await lock.syncLockTime();
        if (result) {
          const time = await lock.getLockTime();
          this.emit("lockTimeUpdated", lock, time);
        }
        return result;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async getCredentials(address, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = store.getCredentialsCache(address);
      if (cached) {
        return cached;
      }
    }
    const passcodes = await this.getPasscodes(address, forceRefresh);
    const cards = await this.getCards(address, forceRefresh);
    const fingers = await this.getFingers(address, forceRefresh);
    const creds = {
      passcodes: passcodes,
      cards: cards,
      fingers: fingers
    };
    if (passcodes !== false || cards !== false || fingers !== false) {
      const existing = store.getCredentialsCache(address) || { passcodes: [], cards: [], fingers: [] };
      const newCreds = {
        passcodes: passcodes !== false ? passcodes : existing.passcodes,
        cards: cards !== false ? cards : existing.cards,
        fingers: fingers !== false ? fingers : existing.fingers
      };
      store.setCredentialsCache(address, newCreds);
      return newCreds;
    }
    return creds;
  }

  async addPasscode(address, type, passCode, startDate, endDate) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasPassCode()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const res = await lock.addPassCode(type, passCode, startDate, endDate);
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async updatePasscode(address, type, oldPasscode, newPasscode, startDate, endDate) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasPassCode()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const res = await lock.updatePassCode(type, oldPasscode, newPasscode, startDate, endDate);
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async deletePasscode(address, type, passCode) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasPassCode()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const res = await lock.deletePassCode(type, passCode);
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async getPasscodes(address, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = store.getCredentialsCache(address);
      if (cached && cached.passcodes) {
        return cached.passcodes;
      }
    }
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasPassCode()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const passcodes = await lock.getPassCodes();
        const cached = store.getCredentialsCache(address) || { passcodes: [], cards: [], fingers: [] };
        cached.passcodes = passcodes;
        store.setCredentialsCache(address, cached);
        return passcodes;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async addCard(address, startDate, endDate, alias) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasICCard()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const card = await lock.addICCard(startDate, endDate);
        store.setCardAlias(card, alias);
        return card;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async updateCard(address, card, startDate, endDate, alias) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasICCard()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const result = await lock.updateICCard(card, startDate, endDate);
        store.setCardAlias(card, alias);
        return result;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async deleteCard(address, card) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasICCard()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const result = await lock.deleteICCard(card);
        store.deleteCardAlias(card);
        return result;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async getCards(address, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = store.getCredentialsCache(address);
      if (cached && cached.cards) {
        return cached.cards;
      }
    }
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasICCard()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        let cards = await lock.getICCards();
        if (cards.length > 0) {
          for (let card of cards) {
            card.alias = store.getCardAlias(card.cardNumber);
          }
        }
        const cached = store.getCredentialsCache(address) || { passcodes: [], cards: [], fingers: [] };
        cached.cards = cards;
        store.setCredentialsCache(address, cached);
        return cards;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async addFinger(address, startDate, endDate, alias) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasFingerprint()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const finger = await lock.addFingerprint(startDate, endDate);
        store.setFingerAlias(finger, alias);
        return finger;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async updateFinger(address, finger, startDate, endDate, alias) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasFingerprint()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const result = await lock.updateFingerprint(finger, startDate, endDate);
        store.setFingerAlias(finger, alias);
        return result;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async deleteFinger(address, finger) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasFingerprint()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const result = await lock.deleteFingerprint(finger);
        store.deleteFingerAlias(finger);
        return result;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async getFingers(address, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = store.getCredentialsCache(address);
      if (cached && cached.fingers) {
        return cached.fingers;
      }
    }
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasFingerprint()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        let fingers = await lock.getFingerprints();
        if (fingers.length > 0) {
          for (let finger of fingers) {
            finger.alias = store.getFingerAlias(finger.fpNumber);
          }
        }
        const cached = store.getCredentialsCache(address) || { passcodes: [], cards: [], fingers: [] };
        cached.fingers = fingers;
        store.setCredentialsCache(address, cached);
        return fingers;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async setAudio(address, audio) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!lock.hasLockSound()) {
        return false;
      }
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const sound = audio == true ? AudioManage.TURN_ON : AudioManage.TURN_OFF;
        const res = await lock.setLockSound(sound);
        this.emit("lockUpdated", lock);
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  async setProactiveLogFetching(address, enabled) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined" && typeof lock.setProactiveLogFetching === "function") {
      lock.setProactiveLogFetching(enabled == true);
    }

    const lockData = store.getLockData();
    let updated = false;
    for (let i = 0; i < lockData.length; i++) {
      if (lockData[i].address == address) {
        lockData[i].proactiveLogs = enabled == true;
        updated = true;
        break;
      }
    }
    if (!updated) {
      lockData.push({
        address: address,
        battery: 0,
        rssi: 0,
        autoLockTime: -1,
        lockedStatus: -1,
        privateData: {},
        operationLog: [],
        proactiveLogs: enabled == true
      });
    }
    await store.setLockData(lockData);
    return true;
  }

  async getOperationLog(address, reload) {
    const lock = this.pairedLocks.get(address);
    if (typeof reload == "undefined") {
      reload = false;
    }
    if (!reload) {
      const cached = store.getOperationsCache(address);
      if (cached) {
        return cached;
      }
    }
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const rawOperations = await lock.getOperationLog(true, reload);
        await this._applyOperationState(lock, rawOperations);
        await this._applyDoorState(lock, rawOperations);
        let operations = JSON.parse(JSON.stringify(rawOperations));
        let validOperations = [];
        // console.log(operations);
        for (let operation of operations) {
          if (operation) {
            operation.recordTypeName = LogOperateNames[operation.recordType];
            if (operation.recordType === LogOperate.DOOR_SENSOR_LOCK) {
              operation.recordTypeCategory = "DOOR_CLOSED";
            } else if (operation.recordType === LogOperate.DOOR_SENSOR_UNLOCK) {
              operation.recordTypeCategory = "DOOR_OPEN";
            } else if (DEADBOLT_LOCK_RECORD_TYPES.includes(operation.recordType)) {
              operation.recordTypeCategory = "LOCK";
            } else if (DEADBOLT_UNLOCK_RECORD_TYPES.includes(operation.recordType)) {
              operation.recordTypeCategory = "UNLOCK";
            } else if (LogOperateCategory.FAILED.includes(operation.recordType)) {
              operation.recordTypeCategory = "FAILED";
            } else {
              operation.recordTypeCategory = "OTHER";
            }
            if (typeof operation.password != "undefined") {
              if (LogOperateCategory.IC.includes(operation.recordType)) {
                operation.passwordName = store.getCardAlias(operation.password);
              } else if (LogOperateCategory.FR.includes(operation.recordType)) {
                operation.passwordName = store.getFingerAlias(operation.password);
              }
            }
            validOperations.push(operation);
          }
        }
        await store.setOperationsCache(address, validOperations);
        return validOperations;
      } catch (error) {
        console.error(error);
      }
    } else {
      return false;
    }
  }

  async resetLock(address) {
    const lock = this.pairedLocks.get(address);
    if (typeof lock != "undefined") {
      if (!(await this._connectLock(lock))) {
        return false;
      }
      try {
        const res = await lock.resetLock();
        if (res) {
          lock.removeAllListeners();
          this.pairedLocks.delete(address);
          this.emit("lockListChanged");
        }
        return res;
      } catch (error) {
        console.error(error);
      }
    }
    return false;
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   * @param {boolean} readData 
   */
  async _connectLock(lock, readData = true) {
    if (this.scanning) return false;
    const address = lock.getAddress();
    while (this.lockMutexes.has(address)) {
      console.log(`[Manager] Connection for ${address} is busy, waiting...`);
      await this.lockMutexes.get(address).promise;
    }
    let resolveLock;
    const promise = new Promise(resolve => { resolveLock = resolve; });
    this.lockMutexes.set(address, { promise, resolve: resolveLock });

    this.interacting = true;
    if (!lock.isConnected()) {
      let wasMonitoring = false;
      try {
        wasMonitoring = this.client.isMonitoring();
        if (wasMonitoring) {
          console.log("[Manager] Stopping monitor before connecting to lock...");
          await this.client.stopMonitor();
        }
        const connectStartedAt = Date.now();
        console.log(`[Manager] Connecting to ${address} (${readData ? 'full data' : 'command only'})`);
        const res = await connectWithPolicy(lock, { readData });
        if (!res) {
          console.log(`[Timing] ${address} connection failed after ${Date.now() - connectStartedAt}ms`);
          console.log("Connect to lock failed", lock.getAddress());
          this.interacting = false;
          this.lockMutexes.delete(address);
          resolveLock();
          if (wasMonitoring) {
            console.log("[Manager] Restarting monitor after failed connection...");
            this.client.startMonitor();
          }
          return false;
        }
        console.log(`[Timing] ${address} connection completed after ${Date.now() - connectStartedAt}ms`);
      } catch (error) {
        console.error(error);
        this.interacting = false;
        this.lockMutexes.delete(address);
        resolveLock();
        if (wasMonitoring) {
          console.log("[Manager] Restarting monitor after connection exception...");
          this.client.startMonitor();
        }
        return false;
      }
      return true;
    }
    return true;
  }

  /**
   * Retry lock/unlock operations after a BLE disconnect while preserving the
   * per-lock connection mutex used by the PiexlPuck branch.
   */
  async _executeWithRetry(lock, operationName, operationFn, maxRetries = 2) {
    const address = lock.getAddress();
    const operationStartedAt = Date.now();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[Manager] ${operationName} attempt ${attempt}/${maxRetries} at +${Date.now() - operationStartedAt}ms`);
      if (!(await this._connectLock(lock, false))) {
        if (!isConnectionRetrySafe(lock)) {
          console.warn(`[Manager] ${operationName} retry suppressed because the cancelled HCI connection did not drain`);
          break;
        }
        if (attempt < maxRetries) await sleep(1500);
        continue;
      }

      try {
        const result = await operationFn();
        if (result !== false || lock.isConnected()) {
          console.log(`[Manager] ${operationName} command completed with result: ${String(result)} after ${Date.now() - operationStartedAt}ms`);
          return result;
        }
        console.warn(`Lock disconnected during ${operationName}; retrying (${attempt}/${maxRetries})`);
      } catch (error) {
        console.error(`Error during ${operationName}:`, error);
        console.warn(`Resetting the BLE connection before retry ${attempt}/${maxRetries}`);
      }

      // Release both the SDK connection and PiexlPuck's mutex before retrying.
      await this.disconnectLock(address);
      if (attempt < maxRetries) await sleep(1500);
    }
    console.log(`[Manager] ${operationName} command failed after ${Date.now() - operationStartedAt}ms`);
    return false;
  }

  async _onScanStarted() {
    this.scanning = true;
    console.log("BLE Scan started");
    this.emit("scanStart");
  }

  async _onScanStopped() {
    this.scanning = false;
    console.log("BLE Scan stopped");
    console.log("Refreshing paired locks");
    for (let address of this.connectQueue) {
      if (this.pairedLocks.has(address)) {
        let lock = this.pairedLocks.get(address);
        console.log("Auto connect to", address);
        const result = await this._connectLock(lock, true);
        if (result === true) {
          await this.disconnectLock(address);
          console.log("Successful connect attempt to paired lock", address);
          this.connectQueue.delete(address);
        } else {
          console.log("Unsuccessful connect attempt to paired lock", address);
        }
      }
    }

    this.emit("scanStop");
    setTimeout(() => {
      this.client.startMonitor();
    }, 200);
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onFoundLock(lock) {
    let listChanged = false;
    if (lock.isPaired()) {
      // check if lock is known
      if (!this.pairedLocks.has(lock.getAddress())) {
        this._bindLockEvents(lock);
        // add it to the list of known locks and connect it
        console.log("Discovered paired lock:", lock.getAddress());
        this.pairedLocks.set(lock.getAddress(), lock);
        if (lock.lockedStatus === LockedStatus.UNKNOWN) {
          this.emit('lockStateUnknown', lock);
        }
        if (this.client.isMonitoring()) {
          const result = await this._connectLock(lock, true);
          if (result == true) {
            console.log("Successful connect attempt to paired lock", lock.getAddress());
            const proactiveLogsEnabled = typeof lock.hasProactiveLogFetching !== "function"
              || lock.hasProactiveLogFetching();
            if (proactiveLogsEnabled) {
              await this._processOperationLog(lock);
            }
            try {
              const time = await lock.getLockTime();
              this.emit("lockTimeUpdated", lock, time);
            } catch (error) {
              console.error("Failed to get lock time during discovery:", error);
            }
          } else {
            console.log("Unsuccessful connect attempt to paired lock", lock.getAddress());
            this.connectQueue.add(lock.getAddress());
          }
          await this.disconnectLock(lock.getAddress());
        } else {
          // add it to the connect queue
          this.connectQueue.add(lock.getAddress());
        }
        listChanged = true;
      }
    } else if (!lock.isInitialized()) {
      if (!this.newLocks.has(lock.getAddress())) {
        // this._bindLockEvents(lock);
        // check if lock is in pairing mode
        // add it to the list of new locks, ready to be initialized
        console.log("Discovered new lock:", lock.toJSON());
        this.newLocks.set(lock.getAddress(), lock);
        listChanged = true;
        if (this.client.isScanning()) {
          console.log("New lock found, stopping scan");
          await this.stopScan();
        }
      }
    } else {
      console.log("Discovered unknown lock:", lock.toJSON());
    }

    if (listChanged) {
      this.emit("lockListChanged");
    }
  }

  async _onUpdatedLockData() {
    await store.setLockData(this.client.getLockData());
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  _bindLockEvents(lock) {
    lock.on("connected", this._onLockConnected.bind(this));
    lock.on("disconnected", this._onLockDisconnected.bind(this));
    lock.on("locked", this._onLockLocked.bind(this));
    lock.on("unlocked", this._onLockUnlocked.bind(this));
    lock.on("updated", this._onLockUpdated.bind(this));
    lock.on("scanICStart", () => this.emit("lockCardScan", lock));
    lock.on("scanFRStart", () => this.emit("lockFingerScan", lock));
    lock.on("scanFRProgress", () => this.emit("lockFingerScanProgress", lock));
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockConnected(lock) {
    if (lock.isPaired()) {
      this.pairedLocks.set(lock.getAddress(), lock);
      console.log("Connected to paired lock " + lock.getAddress());
      this.emit("lockConnected", lock);
    } else {
      console.log("Connected to new lock " + lock.getAddress());
    }
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockDisconnected(lock) {
    console.log("Disconnected from lock " + lock.getAddress());
    if (this.interacting) {
      console.log("[Manager] Skipping monitor auto-restart because an interaction is in progress");
      return;
    }
    this.client.startMonitor();
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockLocked(lock) {
    this.emit("lockLock", lock);
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockUnlocked(lock) {
    this.emit("lockUnlock", lock);
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockUpdated(lock, paramsChanged) {
    const address = lock.getAddress();
    if (this.processingLocks.has(address)) {
      console.log(`[Manager] Already processing update for lock ${address}, skipping concurrent run.`);
      return;
    }
    this.processingLocks.add(address);
    try {
      console.log("lockUpdated", paramsChanged);
      const proactiveLogsEnabled = typeof lock.hasProactiveLogFetching !== "function" || lock.hasProactiveLogFetching();
      if (paramsChanged.newEvents == true && lock.hasNewEvents() && proactiveLogsEnabled) {
        const connected = await this._connectLock(lock, true);
        if (connected) {
          await this._processOperationLog(lock);
        } else {
          console.warn(`[Manager] Could not connect to lock ${address} to process operation log.`);
        }
      }
      if (paramsChanged.lockedStatus == true) {
        const status = await lock.getLockStatus();
        if (status == LockedStatus.LOCKED) {
          console.log(">>>>>> Lock is now locked from new event <<<<<<");
          this.emit("lockLock", lock);
        }
      }
      if (paramsChanged.batteryCapacity == true) {
        this.emit("lockUpdated", lock);
      }
    } catch (error) {
      console.error(`[Manager] Error in _onLockUpdated for lock ${address}:`, error);
    } finally {
      await this.disconnectLock(address);
      this.processingLocks.delete(address);
    }
  }

  async _processOperationLog(lock) {
    const operations = await lock.getOperationLog();
    const lockStatus = await this._applyOperationState(lock, operations);
    await this._applyDoorState(lock, operations);
    return lockStatus;
  }

  async _applyOperationState(lock, operations) {
    const operationState = inferLatestOperationState(
      operations,
      DEADBOLT_LOCK_RECORD_TYPES,
      DEADBOLT_UNLOCK_RECORD_TYPES,
    );

    if (typeof operationState === 'undefined') {
      const previousStatus = lock.lockedStatus;
      lock.lockedStatus = LockedStatus.UNKNOWN;
      await store.setLockData(this.client.getLockData());
      if (previousStatus !== LockedStatus.UNKNOWN) {
        console.log('[Manager] Latest operation does not confirm deadbolt position; publishing unknown state');
        this.emit('lockStateUnknown', lock);
      }
      return LockedStatus.UNKNOWN;
    }

    const confirmedStatus = operationState === OperationState.LOCKED
      ? LockedStatus.LOCKED
      : LockedStatus.UNLOCKED;
    const previousStatus = lock.lockedStatus;

    // TypeScript marks this field protected, but the compiled SDK stores it as
    // a normal JavaScript property. Operation-log records are explicit evidence,
    // unlike the lock's ambiguous idle isUnlock=false advertisement.
    lock.lockedStatus = confirmedStatus;
    await store.setLockData(this.client.getLockData());

    if (previousStatus === confirmedStatus) {
      console.log('[Manager] Operation log confirmed the already-published lock state');
      return confirmedStatus;
    }

    if (confirmedStatus === LockedStatus.LOCKED) {
      console.log('>>>>>> Confirmed locked from operation log <<<<<<');
      this.emit('lockLock', lock);
    } else {
      console.log('>>>>>> Confirmed unlocked from operation log <<<<<<');
      this.emit('lockUnlock', lock);
    }

    return confirmedStatus;
  }

  async _applyDoorState(lock, operations) {
    const doorState = inferLatestDoorState(
      operations,
      LogOperate.DOOR_SENSOR_LOCK,
      LogOperate.DOOR_SENSOR_UNLOCK,
    );
    if (typeof doorState === 'undefined') return undefined;

    const address = lock.getAddress();
    const previousState = store.getDoorState(address);
    await store.setDoorState(address, doorState);
    if (previousState !== doorState) {
      console.log(`[Manager] Door contact is now ${doorState.toLowerCase()}`);
      this.emit('doorStateUpdated', lock, doorState);
    }
    return doorState;
  }

  /** Stop scan after 60 seconds */
  async _scanTimer() {
    if (typeof this.scanTimer == "undefined") {
      this.scanTimer = setTimeout(() => {
        this.stopScan();
      }, 60 * 1000);
    }
  }
}

const manager = new Manager();

module.exports = manager;
