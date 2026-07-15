'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_HOME_ASSISTANT_WEBSOCKET_URL = 'ws://supervisor/core/websocket';

function normalizeHexMap(values) {
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    result[String(key)] = String(value || '').toLowerCase();
  }
  return result;
}

function normalizeHomeAssistantAdvertisement(serviceInfo = {}) {
  return {
    address: String(serviceInfo.address || '').toUpperCase(),
    address_type: null,
    rssi: Number(serviceInfo.rssi),
    name: serviceInfo.name || '',
    service_uuids: Array.isArray(serviceInfo.service_uuids) ? serviceInfo.service_uuids : [],
    service_data: normalizeHexMap(serviceInfo.service_data),
    manufacturer_data: normalizeHexMap(serviceInfo.manufacturer_data),
    source: serviceInfo.source || '',
    connectable: serviceInfo.connectable !== false,
    time: Number(serviceInfo.time),
    raw: serviceInfo.raw || null,
  };
}

class HomeAssistantBluetoothFeed extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.homeAssistantWebSocketUrl
      || process.env.TTLOCK_HA_WEBSOCKET_URL
      || DEFAULT_HOME_ASSISTANT_WEBSOCKET_URL;
    this.token = options.supervisorToken || process.env.SUPERVISOR_TOKEN || '';
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.reconnectDelayMs = Number(options.reconnectDelayMs) || 2000;
    this.subscriptionId = 1;
    this.started = false;
    this.ready = false;
    this.closed = false;
    this.socket = null;
    this.reconnectTimer = null;
  }

  async start(timeoutMs = 15000) {
    if (this.ready) return true;
    if (!this.token) throw new Error('SUPERVISOR_TOKEN is required for the Home Assistant Bluetooth feed');
    this.closed = false;
    if (!this.started) {
      this.started = true;
      this._connect();
    }

    let timer;
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onFatal = error => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            this.off('ready', onReady);
            this.off('fatal', onFatal);
          };
          this.on('ready', onReady);
          this.on('fatal', onFatal);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Home Assistant Bluetooth feed was not ready after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  _connect() {
    if (this.closed) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this._fatal(error);
      return;
    }
    this.socket = socket;
    socket.on('message', data => this._onMessage(data));
    socket.on('error', error => {
      if (!this.ready) this._fatal(error);
      else console.error(`[Bluetooth][Home Assistant] WebSocket error: ${error.message || error}`);
    });
    socket.on('close', () => this._onClose());
  }

  _send(payload) {
    if (!this.socket) throw new Error('Home Assistant Bluetooth WebSocket is not connected');
    this.socket.send(JSON.stringify(payload));
  }

  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error(`[Bluetooth][Home Assistant] Invalid WebSocket message: ${error.message}`);
      return;
    }

    if (message.type === 'auth_required') {
      this._send({ type: 'auth', access_token: this.token });
      return;
    }
    if (message.type === 'auth_invalid') {
      this._fatal(new Error(`Home Assistant WebSocket authentication failed: ${message.message || 'invalid token'}`));
      return;
    }
    if (message.type === 'auth_ok') {
      this._send({ id: this.subscriptionId, type: 'bluetooth/subscribe_advertisements' });
      return;
    }
    if (message.type === 'result' && message.id === this.subscriptionId) {
      if (!message.success) {
        this._fatal(new Error(
          `Home Assistant Bluetooth subscription failed: ${message.error?.message || 'unknown error'}`,
        ));
        return;
      }
      const wasReady = this.ready;
      this.ready = true;
      if (!wasReady) {
        console.log('[Bluetooth][Home Assistant] Advertisement subscription active');
        this.emit('ready');
      }
      return;
    }
    if (message.type !== 'event' || message.id !== this.subscriptionId) return;

    for (const serviceInfo of message.event?.add || []) {
      const device = normalizeHomeAssistantAdvertisement(serviceInfo);
      if (!device.address) continue;
      this.emit('advertisement', {
        type: 'advertisement',
        transport: 'home_assistant',
        proxy: device.source,
        device,
      });
    }
    for (const removed of message.event?.remove || []) {
      this.emit('removed', { address: String(removed.address || '').toUpperCase() });
    }
  }

  _fatal(error) {
    this.ready = false;
    this.closed = true;
    this.started = false;
    this.emit('fatal', error instanceof Error ? error : new Error(String(error)));
    const socket = this.socket;
    this.socket = null;
    if (socket && typeof socket.close === 'function') socket.close();
  }

  _onClose() {
    this.socket = null;
    const wasReady = this.ready;
    this.ready = false;
    if (this.closed) return;
    if (wasReady) console.warn('[Bluetooth][Home Assistant] Advertisement feed disconnected; reconnecting');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelayMs);
  }

  close() {
    this.closed = true;
    this.started = false;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && typeof socket.close === 'function') socket.close();
  }
}

module.exports = {
  DEFAULT_HOME_ASSISTANT_WEBSOCKET_URL,
  HomeAssistantBluetoothFeed,
  normalizeHomeAssistantAdvertisement,
};
