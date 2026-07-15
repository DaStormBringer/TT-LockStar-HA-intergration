'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const CommandApi = require('../api/CommandApi');

const ADDRESS = 'DC:47:11:85:94:2F';

function fakeManager(overrides = {}) {
  return {
    disconnectLock: async () => true,
    ...overrides,
  };
}

test('capability catalog covers the complete high-level SDK command surface', () => {
  const api = new CommandApi(fakeManager());
  const capabilities = api.getCapabilities();
  const names = new Set(capabilities.map(item => item.name));

  assert.equal(capabilities.length, 43);
  for (const name of [
    'lock.prewarm', 'lock.connection.prepare', 'lock.lock', 'lock.unlock', 'lock.status.get', 'lock.features.get', 'lock.device_info.get',
    'lock.time.get', 'lock.time.sync', 'lock.auto_lock.get', 'lock.auto_lock.set',
    'lock.audio.get', 'lock.audio.set', 'lock.passage_mode.get',
    'lock.passage_mode.set', 'lock.passage_mode.delete', 'lock.passage_mode.clear',
    'lock.remote_unlock.get', 'lock.remote_unlock.set',
    'credential.passcode.clear', 'credential.card.clear',
    'credential.fingerprint.clear', 'lock.operations.get', 'lock.reset',
  ]) {
    assert.equal(names.has(name), true, `missing ${name}`);
  }
  assert.equal(capabilities.every(item => !Object.hasOwn(item, 'run')), true);
});

test('hardware feature discovery is read-only and disconnects', async () => {
  const calls = [];
  const manager = fakeManager({
    getLockFeatures: async address => {
      calls.push(['getLockFeatures', address]);
      return { features: [{ value: 0, name: 'PASSCODE' }], readOnly: true };
    },
    disconnectLock: async address => calls.push(['disconnectLock', address]),
  });

  const result = await new CommandApi(manager).execute({
    name: 'lock.features.get',
    address: ADDRESS,
  });

  assert.equal(result.readOnly, true);
  assert.equal(result.result.features[0].name, 'PASSCODE');
  assert.deepEqual(calls, [
    ['getLockFeatures', ADDRESS],
    ['disconnectLock', ADDRESS],
  ]);
});

test('read command validates, dispatches, and disconnects', async () => {
  const calls = [];
  const manager = fakeManager({
    getLockTime: async address => {
      calls.push(['getLockTime', address]);
      return 1720890000000;
    },
    disconnectLock: async address => calls.push(['disconnectLock', address]),
  });

  const result = await new CommandApi(manager).execute({
    name: 'lock.time.get',
    address: ADDRESS.toLowerCase(),
  });

  assert.equal(result.address, ADDRESS);
  assert.equal(result.readOnly, true);
  assert.equal(result.result, 1720890000000);
  assert.deepEqual(calls, [
    ['getLockTime', ADDRESS],
    ['disconnectLock', ADDRESS],
  ]);
});

test('prepared connection is read-only, bounded, and does not auto-disconnect', async () => {
  const calls = [];
  const manager = fakeManager({
    prepareLockConnection: async (address, holdSeconds) => {
      calls.push([address, holdSeconds]);
      return { connected: true, holdSeconds, readOnly: true };
    },
  });
  const api = new CommandApi(manager);

  for (const name of ['lock.prewarm', 'lock.connection.prepare']) {
    const result = await api.execute({
      name, address: ADDRESS, args: { holdSeconds: 20 },
    });
    assert.equal(result.readOnly, true);
    assert.equal(result.result.connected, true);
  }

  assert.deepEqual(calls, [[ADDRESS, 20], [ADDRESS, 20]]);
  assert.equal(api.getCapabilities().find(item => item.name === 'lock.prewarm').autoDisconnect, false);
  assert.equal(api.getCapabilities().find(item => item.name === 'lock.connection.prepare').autoDisconnect, false);
  await assert.rejects(
    api.execute({ name: 'lock.prewarm', address: ADDRESS, args: { holdSeconds: 31 } }),
    /holdSeconds must be an integer from 5 through 30/,
  );
});

test('actuator and destructive commands require exact per-lock confirmation', async () => {
  let unlockCalls = 0;
  let clearCalls = 0;
  const manager = fakeManager({
    unlockLock: async () => { unlockCalls += 1; return true; },
    clearPasscodes: async () => { clearCalls += 1; return true; },
  });
  const api = new CommandApi(manager);

  await assert.rejects(
    api.execute({ name: 'lock.unlock', address: ADDRESS, confirm: 'yes' }),
    /exact confirmation: lock\.unlock DC:47:11:85:94:2F/,
  );
  await api.execute({
    name: 'lock.unlock', address: ADDRESS, confirm: `lock.unlock ${ADDRESS}`,
  });
  await assert.rejects(
    api.execute({ name: 'credential.passcode.clear', address: ADDRESS }),
    /exact confirmation/,
  );
  await api.execute({
    name: 'credential.passcode.clear',
    address: ADDRESS,
    confirm: `credential.passcode.clear ${ADDRESS}`,
  });

  assert.equal(unlockCalls, 1);
  assert.equal(clearCalls, 1);
});

test('invalid command, address, and arguments are rejected before dispatch', async () => {
  const api = new CommandApi(fakeManager({ setAutoLock: async () => true }));

  await assert.rejects(api.execute({ name: 'lock.nope', address: ADDRESS }), /Unsupported command/);
  await assert.rejects(
    api.execute({ name: 'lock.auto_lock.set', address: 'not-a-mac', args: { seconds: 5 } }),
    /address .* is invalid/,
  );
  await assert.rejects(
    api.execute({ name: 'lock.auto_lock.set', address: ADDRESS, args: { seconds: 301 } }),
    /seconds must be an integer from 0 through 300/,
  );
  await assert.rejects(
    api.execute({
      name: 'credential.passcode.add',
      address: ADDRESS,
      args: { type: 1, passCode: '12' },
      confirm: `credential.passcode.add ${ADDRESS}`,
    }),
    /passCode .* is invalid/,
  );
});

test('passage-mode names are normalized to SDK enum values', async () => {
  let received;
  const manager = fakeManager({
    setPassageMode: async (address, data) => {
      received = { address, data };
      return true;
    },
  });
  const api = new CommandApi(manager);

  await api.execute({
    name: 'lock.passage_mode.set',
    address: ADDRESS,
    confirm: `lock.passage_mode.set ${ADDRESS}`,
    args: {
      data: { type: 'WEEKLY', weekOrDay: 0, month: 0, startHour: '0800', endHour: '1700' },
    },
  });

  assert.deepEqual(received, {
    address: ADDRESS,
    data: { type: 1, weekOrDay: 0, month: 0, startHour: '0800', endHour: '1700' },
  });
});

test('a disabled local boolean preference is a successful read result', async () => {
  const api = new CommandApi(fakeManager({ getProactiveLogFetching: () => false }));
  const result = await api.execute({ name: 'lock.proactive_logs.get', address: ADDRESS });

  assert.equal(result.success, true);
  assert.equal(result.result, false);
});
