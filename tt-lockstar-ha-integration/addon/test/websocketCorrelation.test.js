'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

process.env.TTLOCK_BLUETOOTH_TRANSPORT = 'esphome_proxy';

const Message = require('../api/Message');
const WsApi = require('../api/WsApi');

test('websocket messages round-trip optional string and numeric request IDs', () => {
  const stringRequest = new Message(JSON.stringify({
    type: 'command',
    requestId: 'firmware-1',
    data: { name: 'lock.device_info.get' },
  }));
  assert.equal(stringRequest.isValid(), true);
  assert.equal(stringRequest.getRequestId(), 'firmware-1');

  const numericResponse = new Message();
  numericResponse.setType('command');
  numericResponse.setData({ success: true });
  numericResponse.setRequestId(42);
  assert.deepEqual(JSON.parse(numericResponse.toJSON()), {
    type: 'command',
    data: { success: true },
    requestId: 42,
  });

  const legacyResponse = new Message();
  legacyResponse.setType('capabilities');
  legacyResponse.setData({ commands: [] });
  assert.deepEqual(JSON.parse(legacyResponse.toJSON()), {
    type: 'capabilities',
    data: { commands: [] },
  });
});

test('generic direct replies echo the caller request ID', async () => {
  const sent = [];
  const api = new WsApi({ send: payload => sent.push(JSON.parse(payload)) });

  await api.sendCapabilities([], 'capabilities-1');
  await api.sendCommandResult({ success: true }, 7);
  const originalMessage = new Message(JSON.stringify({
    type: 'command',
    requestId: 'failed-1',
    data: { name: 'lock.nope' },
  }));
  await api.sendError('Unsupported command', originalMessage);

  assert.equal(sent[0].type, 'capabilities');
  assert.equal(sent[0].requestId, 'capabilities-1');
  assert.equal(sent[1].type, 'command');
  assert.equal(sent[1].requestId, 7);
  assert.equal(sent[2].type, 'error');
  assert.equal(sent[2].requestId, 'failed-1');
});

test('connection timing separates mutex and fresh-advertisement waits', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(source, /connection mutex wait completed after/);
  assert.match(source, /fresh advertisement wait completed after/);
  assert.match(source, /fresh advertisement wait failed after/);
});
