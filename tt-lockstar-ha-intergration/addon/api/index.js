'use strict';

const { sleep } = require('ttlock-sdk-js/dist/util/timingUtil');
const WebSocket = require('ws');
const manager = require("../src/manager");
const store = require('../src/store');
const Message = require("./Message");
const WsApi = require("./WsApi");
const CommandApi = require("./CommandApi");
const { fetchLockData } = require('../src/ttlockCloudApi');
const {
  convertCloudLockData,
  mergeConvertedLockData,
  validateCloudLockData,
} = require('../src/cloudLockData');

module.exports = async (server) => {
  const commandApi = new CommandApi(manager);
  const wss = new WebSocket.Server({
    server: server,
    path: "/api"
  });

  async function sendStatusUpdate() {
    WsApi.sendStatus(wss);
  }

  async function sendLockStatusUpdate(lock) {
    WsApi.sendLockStatus(wss, lock);
  }

  manager.on("lockListChanged", sendStatusUpdate);
  manager.on("lockPaired", sendStatusUpdate);
  manager.on("lockConnected", sendLockStatusUpdate);
  manager.on("lockLock", sendLockStatusUpdate);
  manager.on("lockUnlock", sendLockStatusUpdate);
  manager.on("lockStateUnknown", sendLockStatusUpdate);
  manager.on("doorStateUpdated", sendLockStatusUpdate);
  manager.on("lockUpdated", sendLockStatusUpdate);
  manager.on("scanStart", sendStatusUpdate);
  manager.on("scanStop", sendStatusUpdate);

  wss.on('connection', (ws) => {

    const api = new WsApi(ws);

    ws.on('message', async (message) => {
      const msg = new Message(message);
      if (msg.isValid()) {
        switch (msg.type) {

          case "status": // send status
            sendStatusUpdate();
            break;

          case "capabilities":
            api.sendCapabilities(commandApi.getCapabilities());
            break;

          case "command":
            try {
              api.sendCommandResult(await commandApi.execute(msg.data));
            } catch (error) {
              console.error("Command API error:", error);
              api.sendError(error.message, msg);
            }
            break;

          case "scan": // start scanning
            manager.startScan();
            break;

          case "stopScan": // stop scanning
            manager.stopScan();
            break;

          case "pair": // pair a lock
            if (msg.data && msg.data.address) {
              try {
                const paired = await manager.initLock(msg.data.address);
                if (!paired) {
                  api.sendError("Pairing failed: Could not initialize lock.", msg);
                  const locks = manager.getNewVisible();
                  const lock = locks.get(msg.data.address);
                  if (lock) {
                    WsApi.sendLockStatus(wss, lock);
                  }
                }
              } catch (error) {
                console.error("Pairing error:", error);
                api.sendError("Pairing error: " + error.message, msg);
                const locks = manager.getNewVisible();
                const lock = locks.get(msg.data.address);
                if (lock) {
                  WsApi.sendLockStatus(wss, lock);
                }
              }
            }
            break;

          case "lock": // lock a lock
            if (msg.data && msg.data.address) {
              console.log(`[API] Received lock command for ${msg.data.address}`);
              const result = await manager.lockLock(msg.data.address);
              if (!result) {
                api.sendError("Lock command failed; physical state was not changed", msg);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "unlock": // unlock a lock
            if (msg.data && msg.data.address) {
              console.log(`[API] Received unlock command for ${msg.data.address}`);
              const result = await manager.unlockLock(msg.data.address);
              if (!result) {
                api.sendError("Unlock command failed; physical state was not changed", msg);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "credentials": // read all credentials from lock
            if (msg.data && msg.data.address) {
              if (process.env.DEV_MODE) {
                WsApi._devSendCredentials(ws);
                break;
              }

              const forceRefresh = !!msg.data.forceRefresh;
              const credentials = await manager.getCredentials(msg.data.address, forceRefresh);
              if (credentials !== false) {
                api.sendCredentials(msg.data.address, credentials);
              } else { // notify failure
                api.sendError("Failed fetching credentials", msg);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "firmware": // read only the firmware revision from a paired lock
            if (msg.data && msg.data.address) {
              const firmwareInfo = await manager.getFirmwareInfo(msg.data.address);
              if (firmwareInfo === false) {
                api.sendError("Failed reading firmware revision", msg);
              } else {
                api.sendFirmwareInfo(firmwareInfo);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "passcode":
            if (msg.data && msg.data.address && msg.data.passcode) {
              if (process.env.DEV_MODE) {
                WsApi._devSendCredentials(ws);
                break;
              }

              const passcode = msg.data.passcode;
              let res = false;
              if (passcode.passCode == -1) { // add
                res = await manager.addPasscode(msg.data.address, passcode.type, passcode.newPassCode, passcode.startDate, passcode.endDate);
              } else if (passcode.newPassCode == -1) { // delete
                res = await manager.deletePasscode(msg.data.address, passcode.type, passcode.passCode);
              } else { // update
                res = await manager.updatePasscode(msg.data.address, passcode.type, passcode.passCode, passcode.newPassCode, passcode.startDate, passcode.endDate);
              }
              if (res) {
                // send updated passcode list
                const passcodes = await manager.getPasscodes(msg.data.address, true);
                if (passcodes !== false) {
                  api.sendPasscodes(msg.data.address, passcodes);
                } else { // notify failure
                  api.sendError("Failed fetching PINs", msg);
                }
              } else { // notify failure
                api.sendError("PIN operation failed", msg);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "card":
            if (msg.data && msg.data.address && msg.data.card) {
              if (process.env.DEV_MODE) {
                WsApi._devSendCredentials(ws);
                break;
              }

              const card = msg.data.card;
              let res = false;
              if (card.cardNumber == -1) { // add new card
                res = await manager.addCard(msg.data.address, card.startDate, card.endDate, card.alias);
              } else if (card.startDate == -1) { // delete
                res = await manager.deleteCard(msg.data.address, card.cardNumber);
              } else { // update
                res = await manager.updateCard(msg.data.address, card.cardNumber, card.startDate, card.endDate, card.alias);
              }
              if (res === false || res == "") { // notify failure
                api.sendError("Card operation failed", msg);
              } else {
                // send updated cards list
                const cards = await manager.getCards(msg.data.address, true);
                if (cards !== false) {
                  api.sendCards(msg.data.address, cards);
                } else { // notify failure
                  api.sendError("Failed fetching cards", msg);
                }
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "finger":
            if (msg.data && msg.data.address && msg.data.finger) {
              if (process.env.DEV_MODE) {
                WsApi._devSendCredentials(ws);
                break;
              }

              const finger = msg.data.finger;
              let res = false;
              if (finger.fpNumber == -1) { // add new finger
                res = await manager.addFinger(msg.data.address, finger.startDate, finger.endDate, finger.alias);
              } else if (finger.startDate == -1) { // delete
                res = await manager.deleteFinger(msg.data.address, finger.fpNumber);
              } else { // update
                res = await manager.updateFinger(msg.data.address, finger.fpNumber, finger.startDate, finger.endDate, finger.alias);
              }
              if (res === false || res == "") { // notify failure
                api.sendError("Fingerprint operation failed", msg);
              } else {
                // send updated fingerprints list
                const fingers = await manager.getFingers(msg.data.address, true);
                if (fingers !== false) {
                  api.sendFingers(msg.data.address, fingers);
                } else { // notify failure
                  api.sendError("Failed fetching fingerprints", msg);
                }
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "settings":
            if (msg.data && msg.data.address && msg.data.settings) {
              const settings = msg.data.settings;
              let confirmedSettings = {};

              if (typeof settings.autolock != "undefined") {
                confirmedSettings.autolock = await manager.setAutoLock(msg.data.address, parseInt(settings.autolock));
                if (confirmedSettings.autolock !== true) {
                  api.sendError("Unable to set auto-lock time", msg);
                }
              }

              if (typeof settings.audio != "undefined") {
                confirmedSettings.audio = await manager.setAudio(msg.data.address, settings.audio);
                if (confirmedSettings.audio !== true) {
                  api.sendError("Failed to set audio mode", msg);
                }
              }

              if (typeof settings.proactiveLogs != "undefined") {
                confirmedSettings.proactiveLogs = await manager.setProactiveLogFetching(msg.data.address, settings.proactiveLogs);
                if (confirmedSettings.proactiveLogs !== true) {
                  api.sendError("Failed to set proactive log fetching", msg);
                }
              }

              if (confirmedSettings.autolock || confirmedSettings.audio || typeof confirmedSettings.proactiveLogs != "undefined") {
                // allow lock status update to be sent before sending configuration confirmation
                await sleep(10);
              }

              const lock = manager.getPairedVisible().get(msg.data.address);
              if (lock) {
                await WsApi.sendLockStatus(wss, lock);
              }

              api.sendSettingsConfirmation(msg.data.address, confirmedSettings);
              await manager.disconnectLock(msg.data.address);
            }
            break;
            
          case "config":
            if (msg.data) {
              if (msg.data.get) {
                api.sendConfig();
              } else if (msg.data.set) {
                try {
                  const lockData = JSON.parse(msg.data.set);
                  store.setLockData(lockData);
                  manager.updateClientLockDataFromStore();
                  manager.startScan();
                  api.sendConfigConfirm();
                } catch (error) {
                  api.sendConfigConfirm("Failed to set config");
                }
              }
            }
            break;

          case "cloudConfig":
            if (msg.data && msg.data.validate) {
              try {
                const lockData = await fetchLockData({
                  clientId: msg.data.clientId,
                  accessToken: msg.data.accessToken,
                  lockId: Number(msg.data.lockId),
                  expectedMac: msg.data.expectedMac,
                });
                const validation = validateCloudLockData(lockData, msg.data.expectedMac);
                if (msg.data.import === true) {
                  if (msg.data.confirmImport !== true) {
                    throw new Error("Cloud import requires explicit confirmation");
                  }
                  const converted = convertCloudLockData(lockData);
                  const updated = mergeConvertedLockData(store.getLockData(), converted);
                  store.setLockData(updated);
                  manager.updateClientLockDataFromStore();
                  manager.startScan();
                  api.sendCloudConfigValidation({
                    ...validation,
                    imported: true,
                    storedLockCount: updated.length,
                  });
                } else {
                  api.sendCloudConfigValidation(validation);
                }
              } catch (error) {
                api.sendCloudConfigValidation({
                  valid: false,
                  error: error.message,
                });
              }
            }
            break;

          case "operations":
            if (msg.data && msg.data.address) {
              const forceRefresh = !!msg.data.forceRefresh;
              const operations = await manager.getOperationLog(msg.data.address, forceRefresh);
              if (operations === false) {
                api.sendError("Failed getting operation log", msg);
              } else {
                api.sendOperationLog(msg.data.address, operations);
              }
              await manager.disconnectLock(msg.data.address);
            }
            break;

          case "unpair":
            if (msg.data && msg.data.address) {
              const res = await manager.resetLock(msg.data.address);
              if (res) {
                // list update will handle the update
              } else {
                api.sendError("Failed to unpair lock", msg);
              }
            }
        }
      }
    });

    async function sendLockCardScan(lock) {
      api.sendCardScan(lock.getAddress());
    }
  
    async function sendLockFingerScan(lock) {
      api.sendFingerScan(lock.getAddress());
    }
  
    async function sendLockFingerScanProgress(lock) {
      api.sendFingerScanProgress(lock.getAddress());
    }
    
    manager.on("lockCardScan", sendLockCardScan);
    manager.on("lockFingerScan", sendLockFingerScan);
    manager.on("lockFingerScanProgress", sendLockFingerScanProgress);
  
    ws.on("close", async () => {
      manager.off("lockCardScan", sendLockCardScan);
      manager.off("lockFingerScan", sendLockFingerScan);
      manager.off("lockFingerScanProgress", sendLockFingerScanProgress);
    });

    WsApi.sendStatus(wss);
  });
}
