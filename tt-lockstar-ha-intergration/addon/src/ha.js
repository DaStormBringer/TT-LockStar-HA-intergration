'use stricet';

const mqtt = require('async-mqtt');
const manager = require('./manager');
const store = require('./store');
const { LockedStatus } = require('ttlock-sdk-js/dist/constant/LockedStatus');
const { getAdvertisementState } = require('./advertisementState');

class HomeAssistant {
  /**
   * 
   * @param {import('./manager')} manager 
   * @param {Object} options
   * @param {string} options.mqttUrl 
   * @param {string} options.mqttUser 
   * @param {string} options.mqttPass 
   * @param {string} options.discovery_prefix 
   */
  constructor(options) {
    this.mqttUrl = options.mqttUrl;
    this.mqttUser = options.mqttUser;
    this.mqttPass = options.mqttPass;
    this.discovery_prefix = options.discovery_prefix || "homeassistant";
    this.configuredLocks = new Set();
    this.lockTimes = new Map();

    this.connected = false;

    manager.on("lockPaired", this._onLockPaired.bind(this));
    manager.on("lockConnected", this._onLockConnected.bind(this));
    manager.on("lockUnlock", this._onLockUnlock.bind(this));
    manager.on("lockLock", this._onLockLock.bind(this));
    manager.on("lockStateUnknown", this._onLockStateUnknown.bind(this));
    manager.on("doorStateUpdated", this._onDoorStateUpdated.bind(this));
    manager.on("lockBatteryUpdated", this._onLockBatteryUpdated.bind(this));
    manager.on("lockTimeUpdated", this._onLockTimeUpdated.bind(this));
    manager.on("lockAdvertisementStateUpdated", this._onLockAdvertisementStateUpdated.bind(this));
  }

  async connect() {
    if (!this.connected) {
      this.client = await mqtt.connectAsync(this.mqttUrl, {
        username: this.mqttUser,
        password: this.mqttPass
      });
      this.client.on("message", this._onMQTTMessage.bind(this));
      await this.client.subscribe("ttlock/+/set");
      await this.client.subscribe("ttlock/+/get_time/set");
      await this.client.subscribe("ttlock/+/sync_time/set");
      this.connected = true;
      console.log("MQTT connected");
    }
  }

  /**
   * Construct a unique ID for a lock, based on the MAC address
   * @param {import('ttlock-sdk-js').TTLock} lock
   */
  getLockId(lock) {
    const address = lock.getAddress();
    return address.split(":").join("").toLowerCase();
  }

  getLockName(lock) {
    const rawName = lock.getName();
    if (typeof rawName === 'string') {
      const cleanName = rawName.replace(/\0/g, '').trim();
      if (cleanName) return cleanName;
    }
    const alias = store.getLockAlias(lock.getAddress(), false);
    if (typeof alias === 'string' && alias.trim()) return alias.trim();
    return "TTLock " + this.getLockId(lock).slice(-6).toUpperCase();
  }

  /**
   * Configure a lock device in HA
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async configureLock(lock) {
    if (this.connected && !this.configuredLocks.has(lock.getAddress())) {
      // setup lock entity
      const id = this.getLockId(lock);
      const name = this.getLockName(lock);
      const device = {
        identifiers: [
          "ttlock_" + id
        ],
        "name": name,
        "manufacturer": lock.getManufacturer(),
        "model": lock.getModel(),
        "sw_version": lock.getFirmware()
      };

      // setup lock state
      const configLockTopic = this.discovery_prefix + "/lock/" + id + "/lock/config";
      const lockPayload = {
        unique_id: "ttlock_" + id,
        name: name,
        device: device,
        state_topic: "ttlock/" + id,
        command_topic: "ttlock/" + id + "/set",
        payload_lock: "LOCK",
        payload_unlock: "UNLOCK",
        state_locked: "LOCK",
        state_unlocked: "UNLOCK",
        value_template: "{{ value_json.state }}",
        availability_topic: "ttlock/" + id,
        availability_template: "{{ value_json.availability }}",
        payload_available: "online",
        payload_not_available: "offline",
        optimistic: false,
        retain: false
      }
      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT Publish", configLockTopic, JSON.stringify(lockPayload));
      }
      let res = await this.client.publish(configLockTopic, JSON.stringify(lockPayload), { retain: true });

      // setup battery sensor
      const configBatteryTopic = this.discovery_prefix + "/sensor/" + id + "/battery/config";
      const batteryPayload = {
        unique_id: "ttlock_" + id + "_battery",
        name: name + " Battery",
        device: device,
        device_class: "battery",
        unit_of_measurement: "%",
        state_topic: "ttlock/" + id,
        value_template: "{{ value_json.battery }}",
      }
      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT Publish", configBatteryTopic, JSON.stringify(batteryPayload));
      }
      res = await this.client.publish(configBatteryTopic, JSON.stringify(batteryPayload), { retain: true });

      // setup rssi sensor
      const configRssiTopic = this.discovery_prefix + "/sensor/" + id + "/rssi/config";
      const rssiPayload = {
        unique_id: "ttlock_" + id + "_rssi",
        name: name + " RSSI",
        device: device,
        unit_of_measurement: "dB",
        icon: "mdi:signal",
        state_topic: "ttlock/" + id,
        value_template: "{{ value_json.rssi }}",
      }
      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT Publish", configRssiTopic, JSON.stringify(rssiPayload));
      }
      res = await this.client.publish(configRssiTopic, JSON.stringify(rssiPayload), { retain: true });

      // setup a diagnostic sensor for the raw advertisement isUnlock bit.
      // IDLE_NO_UNLOCK_SIGNAL is intentionally not presented as confirmed LOCKED.
      const configAdvertisedStateTopic = this.discovery_prefix
        + "/sensor/" + id + "/advertised_lock_state/config";
      const advertisedStatePayload = {
        unique_id: "ttlock_" + id + "_advertised_lock_state",
        name: name + " Advertised Lock State",
        device: device,
        entity_category: "diagnostic",
        icon: "mdi:lock-question",
        state_topic: "ttlock/" + id,
        value_template: "{{ value_json.advertised_lock_state }}",
        json_attributes_topic: "ttlock/" + id,
        json_attributes_template: "{{ {'advertised_is_unlock': value_json.advertised_is_unlock, 'advertised_at': value_json.advertised_at, 'advertised_has_events': value_json.advertised_has_events, 'advertised_confirmed': false, 'advertised_manufacturer_data_hex': value_json.advertised_manufacturer_data_hex, 'advertised_payload_signature': value_json.advertised_payload_signature} | tojson }}",
      };
      res = await this.client.publish(
        configAdvertisedStateTopic,
        JSON.stringify(advertisedStatePayload),
        { retain: true },
      );

      // setup magnetic door-contact sensor separately from deadbolt state
      const configDoorTopic = this.discovery_prefix + "/binary_sensor/" + id + "/door/config";
      const doorPayload = {
        unique_id: "ttlock_" + id + "_door",
        name: name + " Door",
        device: device,
        device_class: "door",
        state_topic: "ttlock/" + id,
        value_template: "{{ value_json.door }}",
        payload_on: "OPEN",
        payload_off: "CLOSED"
      };
      res = await this.client.publish(configDoorTopic, JSON.stringify(doorPayload), { retain: true });

      // setup lock time sensor
      const configLockTimeTopic = this.discovery_prefix + "/sensor/" + id + "/lock_time/config";
      const lockTimePayload = {
        unique_id: "ttlock_" + id + "_lock_time",
        name: name + " Time",
        device: device,
        device_class: "timestamp",
        state_topic: "ttlock/" + id,
        value_template: "{{ value_json.lock_time }}",
      }
      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT Publish", configLockTimeTopic, JSON.stringify(lockTimePayload));
      }
      res = await this.client.publish(configLockTimeTopic, JSON.stringify(lockTimePayload), { retain: true });

      // setup get lock time button
      const configGetTimeTopic = this.discovery_prefix + "/button/" + id + "/get_time/config";
      const getTimePayload = {
        unique_id: "ttlock_" + id + "_get_time",
        name: "Get " + name + " Time",
        device: device,
        command_topic: "ttlock/" + id + "/get_time/set",
        payload_press: "PRESS"
      }
      res = await this.client.publish(configGetTimeTopic, JSON.stringify(getTimePayload), { retain: true });

      // setup sync lock time button
      const configSyncTimeTopic = this.discovery_prefix + "/button/" + id + "/sync_time/config";
      const syncTimePayload = {
        unique_id: "ttlock_" + id + "_sync_time",
        name: "Sync " + name + " Time",
        device: device,
        command_topic: "ttlock/" + id + "/sync_time/set",
        payload_press: "PRESS"
      }
      res = await this.client.publish(configSyncTimeTopic, JSON.stringify(syncTimePayload), { retain: true });

      this.configuredLocks.add(lock.getAddress());

    }
  }

  /**
   * Update the readings of a lock in HA
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async updateLockState(lock) {
    if (this.connected) {
      const id = this.getLockId(lock);
      const stateTopic = "ttlock/" + id;
      const lockedStatus = await lock.getLockStatus();
      const advertisement = getAdvertisementState(lock.getAddress());
      let statePayload = {
        battery: lock.getBattery(),
        rssi: lock.getRssi(),
        state: "UNKNOWN",
        availability: lockedStatus == LockedStatus.UNKNOWN ? "offline" : "online",
        door: store.getDoorState(lock.getAddress()) || "UNKNOWN",
        advertised_lock_state: advertisement.state,
        advertised_is_unlock: advertisement.isUnlock,
        advertised_at: advertisement.observedAt,
        advertised_has_events: advertisement.hasEvents,
        advertised_confirmed: false,
        advertised_manufacturer_data_hex: advertisement.manufacturerDataHex,
        advertised_payload_signature: advertisement.payloadSignature,
      }
      if (this.lockTimes.has(id)) {
        statePayload.lock_time = this.lockTimes.get(id);
      }
      if (lockedStatus != LockedStatus.UNKNOWN) {
        statePayload.state = lockedStatus == LockedStatus.LOCKED ? "LOCK" : "UNLOCK";
      }

      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT Publish", stateTopic, JSON.stringify(statePayload));
      }
      const res = await this.client.publish(stateTopic, JSON.stringify(statePayload), { retain: true });
    }
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockPaired(lock) {
    await this.configureLock(lock);
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockConnected(lock) {
    // Send the Auto-Discovery config to Home Assistant
    await this.configureLock(lock);
    await this.updateLockState(lock);
  }
  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockUnlock(lock) {
    await this.updateLockState(lock);
  }

  /**
   * 
   * @param {import('ttlock-sdk-js').TTLock} lock 
   */
  async _onLockLock(lock) {
    await this.updateLockState(lock);
  }

  async _onLockStateUnknown(lock) {
    await this.configureLock(lock);
    await this.updateLockState(lock);
  }

  async _onDoorStateUpdated(lock) {
    await this.configureLock(lock);
    await this.updateLockState(lock);
  }

  /**
   * @param {import('ttlock-sdk-js').TTLock} lock
   */
  async _onLockBatteryUpdated(lock) {
    await this.updateLockState(lock);
  }

  async _onLockAdvertisementStateUpdated(lock) {
    await this.configureLock(lock);
    await this.updateLockState(lock);
  }

  /**
   * @param {import('ttlock-sdk-js').TTLock} lock
   * @param {number} time
   */
  async _onLockTimeUpdated(lock, time) {
    if (this.connected) {
      const id = this.getLockId(lock);
      this.lockTimes.set(id, new Date(time).toISOString());
      await this.updateLockState(lock);
    }
  }

  /**
   * 
   * @param {string} topic 
   * @param {Buffer} message 
   */
  async _onMQTTMessage(topic, message) {
    /**
     * Topic: ttlock/e1581b3a605e/set
       Message: UNLOCK
     */

    let topicArr = topic.split("/");
    if (topicArr.length >= 3 && topicArr[0] == "ttlock" && topicArr[1].length == 12) {
      let address = "";
      for (let i = 0; i < topicArr[1].length; i++) {
        address += topicArr[1][i];
        if (i < topicArr[1].length - 1 && i % 2 == 1) {
          address += ":";
        }
      }
      address = address.toUpperCase();
      const command = message.toString('utf8');
      if (process.env.MQTT_DEBUG == "1") {
        console.log("MQTT command:", address, topicArr[2], command);
      }
      if (topicArr[2] == "set") {
        switch (command) {
          case "LOCK":
            console.log(`[MQTT] Received LOCK command for ${address}`);
            try {
              await manager.lockLock(address);
            } finally {
              await manager.disconnectLock(address);
            }
            break;
          case "UNLOCK":
            console.log(`[MQTT] Received UNLOCK command for ${address}`);
            try {
              await manager.unlockLock(address);
            } finally {
              await manager.disconnectLock(address);
            }
            break;
        }
      } else if (topicArr[2] == "get_time" && topicArr[3] == "set" && command === "PRESS") {
        try {
          await manager.getLockTime(address);
        } finally {
          await manager.disconnectLock(address);
        }
      } else if (topicArr[2] == "sync_time" && topicArr[3] == "set" && command === "PRESS") {
        try {
          await manager.syncLockTime(address);
        } finally {
          await manager.disconnectLock(address);
        }
      }
    } else if (process.env.MQTT_DEBUG == "1") {

      console.log("Topic:", topic);
      console.log("Message:", message.toString('utf8'));
    }
  }
}

module.exports = HomeAssistant;
