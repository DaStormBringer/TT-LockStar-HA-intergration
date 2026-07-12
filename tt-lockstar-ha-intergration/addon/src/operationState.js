'use strict';

const OperationState = Object.freeze({
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED',
});

const DoorState = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
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
 * Infer deadbolt state only when the newest operation itself is explicit
 * lock/unlock evidence. A newer contact or unrelated event makes it unknown.
 */
function latestOperation(operations, predicate = () => true) {
  if (!Array.isArray(operations)) return undefined;

  let latest;
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (!operation || typeof operation.recordType === 'undefined' || !predicate(operation)) continue;

    const key = operationSortKey(operation, index);
    if (isNewer(key, latest && latest.key)) {
      latest = { operation, key };
    }
  }

  return latest && latest.operation;
}

function inferLatestOperationState(operations, lockRecordTypes, unlockRecordTypes) {
  const operation = latestOperation(operations);
  if (!operation) return undefined;

  if (lockRecordTypes.includes(operation.recordType)) return OperationState.LOCKED;
  if (unlockRecordTypes.includes(operation.recordType)) return OperationState.UNLOCKED;
  return undefined;
}

function inferLatestDoorState(operations, doorClosedRecordType, doorOpenRecordType) {
  const operation = latestOperation(
    operations,
    candidate => candidate.recordType === doorClosedRecordType
      || candidate.recordType === doorOpenRecordType,
  );
  if (!operation) return undefined;

  return operation.recordType === doorClosedRecordType
    ? DoorState.CLOSED
    : DoorState.OPEN;
}

module.exports = {
  DoorState,
  OperationState,
  inferLatestDoorState,
  inferLatestOperationState,
};
