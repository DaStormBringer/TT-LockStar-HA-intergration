'use strict';

/**
 * @typedef {'status'|'scan'|'pair'|'lock'|'unlock'|'lockStatus'
 * |'credentials'|'passcode'|'card'|'finger'|'error'|'config'
 * |'settings'|'operations'|'firmware'|'unpair'|'capabilities'|'command'} MessageType
 */

class Message {
  /**
   * @type {MessageType} Message type
   */
  type;

  /**
   * @type {Object|undefined} Data payload
   */
  data;

  /**
   * @type {string|number|undefined} Optional caller-supplied correlation ID
   */
  requestId;

  /**
   * @type {boolean} Message is valid
   */
  valid = false;

  /**
   * 
   * @param {import('ws').Data} payload 
   */
  constructor(payload) {
    if (typeof payload != "undefined") {
      try {
        const json = JSON.parse(payload);
        if (typeof json.type != "undefined") {
          this.type = json.type;
          if (typeof json.data != "undefined") {
            this.data = json.data;
          }
          if (
            typeof json.requestId === "string"
            || (typeof json.requestId === "number" && Number.isFinite(json.requestId))
          ) {
            this.requestId = json.requestId;
          }
          this.valid = true;
        }
      } catch (error) {
        console.error("Error parsing Message payload", error);
      }
    } else {
      
    }
  }

  getType() {
    return this.type;
  }

  /**
   * 
   * @param {MessageType} type 
   */
  setType(type) {
    this.type = type;
  }

  getData() {
    return this.data;
  }

  setData(data) {
    this.data = data;
  }

  getRequestId() {
    return this.requestId;
  }

  setRequestId(requestId) {
    if (
      typeof requestId === "string"
      || (typeof requestId === "number" && Number.isFinite(requestId))
    ) {
      this.requestId = requestId;
    }
  }

  isValid() {
    return this.valid;
  }

  toJSON() {
    const obj = {
      type: this.type,
      data: this.data
    };

    if (typeof this.requestId !== "undefined") {
      obj.requestId = this.requestId;
    }

    return JSON.stringify(obj);
  }
}

module.exports = Message;
