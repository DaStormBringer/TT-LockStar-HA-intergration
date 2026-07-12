'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OperationState,
  inferLatestOperationState,
} = require('../src/operationState');

const LOCK_TYPES = [10, 11];
const UNLOCK_TYPES = [20, 21];

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

test('ignores unrelated operations and preserves unknown when no state evidence exists', () => {
  assert.equal(
    inferLatestOperationState([
      { recordType: 99, operateDate: '20260711230000' },
      null,
    ], LOCK_TYPES, UNLOCK_TYPES),
    undefined,
  );
});
