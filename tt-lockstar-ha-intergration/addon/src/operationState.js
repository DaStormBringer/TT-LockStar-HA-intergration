'use strict';

const OperationState = Object.freeze({
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED',
});

function operationSortKey(operation, index) {
  const operateDate = typeof operation.operateDate === 'string'
    ? operation.operateDate.replace(/\D/g, '')
    : '';
  const recordNumber = Number.isFinite(operation.recordNumber)
    ? operation.recordNumber
    : -1;

  return {
    hasDate: operateDate.length === 14,
    operateDate,
    recordNumber,
    index,
  };
}

function isNewer(candidate, current) {
  if (!current) return true;
  if (candidate.hasDate !== current.hasDate) return candidate.hasDate;
  if (candidate.hasDate && candidate.operateDate !== current.operateDate) {
    return candidate.operateDate > current.operateDate;
  }
  if (candidate.recordNumber !== current.recordNumber) {
    return candidate.recordNumber > current.recordNumber;
  }
  return candidate.index > current.index;
}

/**
 * Infer a confirmed state from the newest explicit lock/unlock operation.
 * Idle BLE advertisements are deliberately excluded from this decision.
 */
function inferLatestOperationState(operations, lockRecordTypes, unlockRecordTypes) {
  if (!Array.isArray(operations)) return undefined;

  let latest;
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (!operation || typeof operation.recordType === 'undefined') continue;

    let state;
    if (lockRecordTypes.includes(operation.recordType)) {
      state = OperationState.LOCKED;
    } else if (unlockRecordTypes.includes(operation.recordType)) {
      state = OperationState.UNLOCKED;
    } else {
      continue;
    }

    const key = operationSortKey(operation, index);
    if (isNewer(key, latest && latest.key)) {
      latest = { state, key };
    }
  }

  return latest && latest.state;
}

module.exports = {
  OperationState,
  inferLatestOperationState,
};
