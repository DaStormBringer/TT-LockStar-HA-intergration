'use strict';

const fs = require('fs').promises;

class Store {
  constructor() {
    this.settingsPath = "/data";
    this.lockData = [];
    this.aliasData = {
      lock: {},
      card: {},
      finger: {}
    };
    this.credentialsCache = {};
    this.operationsCache = {};
    this.stateData = {
      schemaVersion: 1,
      doorStates: {}
    };
  }

  setDataPath(path) {
    this.settingsPath = path;
  }

  getDataPath() {
    return this.settingsPath;
  }

  setLockData(newData) {
    this.lockData = newData;
    return this.saveData();
  }

  getLockData() {
    return this.lockData;
  }

  setLockAlias(address, alias) {
    this.aliasData.lock[address] = alias;
    this.saveData();
  }

  getLockAlias(address, defaultValue = false) {
    if (typeof this.aliasData.lock[address] != "undefined") {
      return this.aliasData.lock[address];
    } else {
      return defaultValue;
    }
  }

  setCardAlias(card, alias) {
    if (typeof alias != "undefined" && alias != "") {
      this.aliasData.card[card] = alias;
      this.saveData();
    }
  }

  getCardAlias(card) {
    if (typeof this.aliasData.card[card] != "undefined") {
      return this.aliasData.card[card];
    } else {
      return card;
    }
  }

  deleteCardAlias(card) {
    delete this.aliasData.card[card];
    this.saveData();
  }

  setFingerAlias(finger, alias) {
    this.aliasData.finger[finger] = alias;
    this.saveData();
  }

  getFingerAlias(finger) {
    if (typeof this.aliasData.finger[finger] != "undefined") {
      return this.aliasData.finger[finger];
    } else {
      return finger;
    }
  }

  deleteFingerAlias(finger) {
    delete this.aliasData.finger[finger];
    this.saveData();
  }

  getCredentialsCache(address) {
    return this.credentialsCache[address] || null;
  }

  setCredentialsCache(address, creds) {
    this.credentialsCache[address] = creds;
    return this.saveData();
  }

  setCredentialList(address, kind, values) {
    const cached = this.credentialsCache[address] || {};
    cached[kind] = values;
    this.credentialsCache[address] = cached;
    return this.saveData();
  }

  invalidateCredentialList(address, kind) {
    const cached = this.credentialsCache[address];
    if (cached) delete cached[kind];
    return this.saveData();
  }

  getOperationsCache(address) {
    return this.operationsCache[address] || null;
  }

  setOperationsCache(address, ops) {
    this.operationsCache[address] = ops;
    return this.saveData();
  }

  getDoorState(address) {
    return this.stateData.doorStates[address];
  }

  setDoorState(address, state) {
    this.stateData.doorStates[address] = state;
    return this.saveData();
  }

  async migrateDeadboltStateSchema(targetVersion) {
    if (this.stateData.schemaVersion >= targetVersion) return false;

    for (const lock of this.lockData) {
      lock.lockedStatus = -1;
    }
    this.operationsCache = {};
    this.stateData.schemaVersion = targetVersion;
    await this.saveData();
    return true;
  }

  async loadData() {
    try {
      await fs.access(this.settingsPath + "/lockData.json");
      const lockDataTxt = (await fs.readFile(this.settingsPath + "/lockData.json")).toString();
      this.lockData = JSON.parse(lockDataTxt);
    } catch (error) {
      this.lockData = [];
      if (error.code !== 'ENOENT') {
        console.error("Error loading lockData.json:", error);
      }
    }
    try {
      await fs.access(this.settingsPath + "/aliasData.json");
      const aliasDataTxt = (await fs.readFile(this.settingsPath + "/aliasData.json")).toString();
      this.aliasData = JSON.parse(aliasDataTxt);
    } catch (error) {
      this.aliasData = {
        lock: {},
        card: {},
        finger: {}
      };
      if (error.code !== 'ENOENT') {
        console.error("Error loading aliasData.json:", error);
      }
    }
    try {
      await fs.access(this.settingsPath + "/credentialsCache.json");
      const credsTxt = (await fs.readFile(this.settingsPath + "/credentialsCache.json")).toString();
      this.credentialsCache = JSON.parse(credsTxt);
    } catch (error) {
      this.credentialsCache = {};
    }
    try {
      await fs.access(this.settingsPath + "/operationsCache.json");
      const opsTxt = (await fs.readFile(this.settingsPath + "/operationsCache.json")).toString();
      this.operationsCache = JSON.parse(opsTxt);
    } catch (error) {
      this.operationsCache = {};
    }
    try {
      await fs.access(this.settingsPath + "/stateData.json");
      const stateTxt = (await fs.readFile(this.settingsPath + "/stateData.json")).toString();
      const stateData = JSON.parse(stateTxt);
      this.stateData = {
        schemaVersion: Number.isInteger(stateData.schemaVersion) ? stateData.schemaVersion : 1,
        doorStates: stateData.doorStates && typeof stateData.doorStates === 'object'
          ? stateData.doorStates
          : {}
      };
    } catch (error) {
      this.stateData = {
        schemaVersion: 1,
        doorStates: {}
      };
    }

    return this.lockData;
  }

  async saveData() {
    try {
      await fs.writeFile(this.settingsPath + "/lockData.json", Buffer.from(JSON.stringify(this.lockData)));
    } catch (error) {
      console.error(error);
    }
    try {
      await fs.writeFile(this.settingsPath + "/aliasData.json", Buffer.from(JSON.stringify(this.aliasData)));
    } catch (error) {
      console.error(error);
    }
    try {
      await fs.writeFile(this.settingsPath + "/credentialsCache.json", Buffer.from(JSON.stringify(this.credentialsCache)));
    } catch (error) {
      console.error(error);
    }
    try {
      await fs.writeFile(this.settingsPath + "/operationsCache.json", Buffer.from(JSON.stringify(this.operationsCache)));
    } catch (error) {
      console.error(error);
    }
    try {
      await fs.writeFile(this.settingsPath + "/stateData.json", Buffer.from(JSON.stringify(this.stateData)));
    } catch (error) {
      console.error(error);
    }
  }
}

const store = new Store();

module.exports = store;
module.exports.Store = Store;
