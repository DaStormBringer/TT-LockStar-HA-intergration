'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DoorState,
  OperationState,
  inferLatestDoorState,
  inferLatestOperationState,
} = require('../src/operationState');
const { Store } = require('../src/store');

const LOCK_TYPES = [10, 11];
const UNLOCK_TYPES = [20, 21];
const DOOR_CLOSED_TYPE = 30;
const DOOR_OPEN_TYPE = 31;

test('selects the newest explicit operation regardless of array order', () => {
  const operations = [
    { recordType: 10, operateDate: '20260711230000', recordNumber: 41 },
    { recordType: 20, operateDate: '20260711225500', recordNumber: 40 },
  ];

  assert.equal(
    inferLatestOperationState(operations.reverse(), LOCK_TYPES, UNLOCK_TYPES),
    OperationState.LOCKED,
  );
});

test('uses record number and then array order when timestamps are unavailable', () => {
  assert.equal(
    inferLatestOperationState([
      { recordType: 10, recordNumber: 7 },
      { recordType: 20, recordNumber: 8 },
    ], LOCK_TYPES, UNLOCK_TYPES),
    OperationState.UNLOCKED,
  );

  assert.equal(
    inferLatestOperationState([
      { recordType: 20 },
      { recordType: 10 },
    ], LOCK_TYPES, UNLOCK_TYPES),
    OperationState.LOCKED,
  );
});

test('returns unknown when the newest operation does not confirm deadbolt position', () => {
  assert.equal(
    inferLatestOperationState([
      { recordType: 10, operateDate: '20260711230000' },
      { recordType: DOOR_CLOSED_TYPE, operateDate: '20260711230500' },
    ], LOCK_TYPES, UNLOCK_TYPES),
    undefined,
  );
});

test('tracks the newest magnetic contact event separately from deadbolt state', () => {
  const operations = [
    { recordType: DOOR_OPEN_TYPE, operateDate: '20260711230000' },
    { recordType: DOOR_CLOSED_TYPE, operateDate: '20260711230500' },
    { recordType: 99, operateDate: '20260711231000' },
  ];

  assert.equal(
    inferLatestDoorState(operations, DOOR_CLOSED_TYPE, DOOR_OPEN_TYPE),
    DoorState.CLOSED,
  );
});

test('state schema migration invalidates legacy inferred deadbolt status once', async () => {
  const store = new Store();
  store.lockData = [{ address: 'AA:BB:CC:DD:EE:FF', lockedStatus: 0 }];
  store.operationsCache = { 'AA:BB:CC:DD:EE:FF': [{ recordType: 30 }] };
  store.saveData = async () => {};

  assert.equal(await store.migrateDeadboltStateSchema(2), true);
  assert.equal(store.lockData[0].lockedStatus, -1);
  assert.deepEqual(store.operationsCache, {});
  assert.equal(await store.migrateDeadboltStateSchema(2), false);
});

test('manual operation-log refresh routes raw records through state reconciliation', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(
    managerSource,
    /const rawOperations = await lock\.getOperationLog\(true, reload\);\s+await this\._applyOperationState\(lock, rawOperations\);\s+await this\._applyDoorState\(lock, rawOperations\);/,
  );
});

test('door-contact record types are excluded from deadbolt categories', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(managerSource, /recordType !== LogOperate\.DOOR_SENSOR_LOCK/);
  assert.match(managerSource, /recordType !== LogOperate\.DOOR_SENSOR_UNLOCK/);
  assert.match(managerSource, /this\.emit\('lockStateUnknown', lock\)/);
});

test('repeated log confirmation does not emit a duplicate state event', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(
    managerSource,
    /if \(previousStatus === confirmedStatus\) \{[\s\S]*?return confirmedStatus;\s+\}/,
  );
});

test('initial discovery honors the proactive log-fetch setting', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(
    managerSource,
    /Successful connect attempt to paired lock[\s\S]*?hasProactiveLogFetching\(\)[\s\S]*?if \(proactiveLogsEnabled\) \{\s+await this\._processOperationLog\(lock\);/,
  );
});

test('publishes magnetic contact discovery independently from lock state', () => {
  const haSource = fs.readFileSync(path.join(__dirname, '../src/ha.js'), 'utf8');

  assert.match(haSource, /\/binary_sensor\/" \+ id \+ "\/door\/config/);
  assert.match(haSource, /device_class: "door"/);
  assert.match(haSource, /payload_on: "OPEN"/);
  assert.match(haSource, /payload_off: "CLOSED"/);
  assert.match(haSource, /state: "UNKNOWN"/);
  assert.match(haSource, /availability_template: "\{\{ value_json\.availability \}\}"/);
  assert.match(haSource, /availability: lockedStatus == LockedStatus\.UNKNOWN \? "offline" : "online"/);
  assert.match(haSource, /rawName\.replace\(\/\\0\/g, ''\)\.trim\(\)/);
  assert.match(haSource, /async _onLockStateUnknown\(lock\) \{\s+await this\.configureLock\(lock\);/);
});

test('publishes unknown deadbolt state before a BLE connection succeeds', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '../src/manager.js'), 'utf8');

  assert.match(
    managerSource,
    /this\.pairedLocks\.set\(lock\.getAddress\(\), lock\);[\s\S]*?if \(lock\.lockedStatus === LockedStatus\.UNKNOWN\) \{\s+this\.emit\('lockStateUnknown', lock\);/,
  );
});

test('publishes advertisement state as a separate experimental diagnostic', () => {
  const haSource = fs.readFileSync(path.join(__dirname, '../src/ha.js'), 'utf8');
  const lockApiSource = fs.readFileSync(path.join(__dirname, '../api/Lock.js'), 'utf8');

  assert.match(haSource, /\/advertised_lock_state\/config/);
  assert.match(haSource, /entity_category: "diagnostic"/);
  assert.match(haSource, /advertised_lock_state: advertisement\.state/);
  assert.match(haSource, /advertised_confirmed: false/);
  assert.match(lockApiSource, /advertisedLockState = advertisement\.state/);
  assert.match(lockApiSource, /advertisedIsUnlock = advertisement\.isUnlock/);
  assert.match(lockApiSource, /advertisedConfirmed = false/);
});
