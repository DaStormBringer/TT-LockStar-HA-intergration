'use strict';

const ADDRESS_PATTERN = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const DATE_PATTERN = /^\d{12}$/;
const PASSCODE_PATTERN = /^\d{4,9}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3])[0-5]\d$/;

const DEVICE_INFO_TYPES = Object.freeze([
  'MODEL_NUMBER',
  'HARDWARE_REVISION',
  'FIRMWARE_REVISION',
  'MANUFACTURE_DATE',
  'MAC_ADDRESS',
  'LOCK_CLOCK',
  'NB_OPERATOR',
  'NB_IMEI',
  'NB_CARD_INFO',
  'NB_RSSI',
]);

function fail(message) {
  throw new Error(message);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requireString(args, name, pattern, description = name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    fail(`${description} is invalid`);
  }
  return value;
}

function optionalString(args, name, pattern, description = name) {
  if (args[name] === undefined || args[name] === null || args[name] === '') return undefined;
  return requireString(args, name, pattern, description);
}

function requireBoolean(args, name) {
  if (typeof args[name] !== 'boolean') fail(`${name} must be a boolean`);
  return args[name];
}

function optionalBoolean(args, name, fallback = false) {
  if (args[name] === undefined) return fallback;
  return requireBoolean(args, name);
}

function requireInteger(args, name, minimum, maximum) {
  const value = args[name];
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizePassageMode(args) {
  const data = requireObject(args.data, 'data');
  let type = data.type;
  if (typeof type === 'string') {
    type = { WEEKLY: 1, MONTHLY: 2 }[type.toUpperCase()];
  }
  if (![1, 2].includes(type)) fail('data.type must be WEEKLY, MONTHLY, 1, or 2');
  const maxDay = type === 1 ? 7 : 31;
  const weekOrDay = requireInteger(data, 'weekOrDay', type === 1 ? 0 : 1, maxDay);
  const month = requireInteger(data, 'month', 0, 12);
  const startHour = requireString(data, 'startHour', TIME_PATTERN, 'data.startHour (HHmm)');
  const endHour = requireString(data, 'endHour', TIME_PATTERN, 'data.endHour (HHmm)');
  return { type, weekOrDay, month, startHour, endHour };
}

function command(name, description, options) {
  return Object.freeze({ name, description, ...options });
}

const COMMANDS = Object.freeze([
  command('system.scan.start', 'Start local BLE lock discovery.', {
    risk: 'local', readOnly: false, requiresAddress: false,
    run: manager => manager.startScan(),
  }),
  command('system.scan.stop', 'Stop local BLE lock discovery.', {
    risk: 'local', readOnly: false, requiresAddress: false,
    run: manager => manager.stopScan(),
  }),
  command('lock.pair', 'Initialize and pair a discovered lock.', {
    risk: 'security', readOnly: false, confirmationRequired: true,
    run: (manager, address) => manager.initLock(address),
  }),
  command('lock.disconnect', 'End the current BLE session.', {
    risk: 'local', readOnly: false,
    run: (manager, address) => manager.disconnectLock(address),
  }),
  command('lock.lock', 'Physically engage the deadbolt.', {
    risk: 'actuator', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.lockLock(address),
  }),
  command('lock.unlock', 'Physically retract the deadbolt.', {
    risk: 'actuator', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.unlockLock(address),
  }),
  command('lock.status.get', 'Return the last evidence-backed deadbolt and door state.', {
    risk: 'read_only', readOnly: true,
    run: (manager, address) => manager.getLockStatusEvidence(address),
  }),
  command('lock.device_info.get', 'Read one COMM_READ_DEVICE_INFO field.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    args: { infoType: DEVICE_INFO_TYPES },
    validate: args => {
      const infoType = requireString(args, 'infoType').toUpperCase();
      if (!DEVICE_INFO_TYPES.includes(infoType)) fail(`infoType must be one of: ${DEVICE_INFO_TYPES.join(', ')}`);
      return { infoType };
    },
    run: (manager, address, args) => manager.getDeviceInfo(address, args.infoType),
  }),
  command('lock.time.get', 'Read the lock clock.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    run: (manager, address) => manager.getLockTime(address),
  }),
  command('lock.time.sync', 'Synchronize the lock clock.', {
    risk: 'setting', readOnly: false, disconnect: true,
    run: (manager, address) => manager.syncLockTime(address),
  }),
  command('lock.auto_lock.get', 'Read the auto-lock delay.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    run: (manager, address) => manager.getAutoLock(address),
  }),
  command('lock.auto_lock.set', 'Set the auto-lock delay in seconds (zero disables it).', {
    risk: 'setting', readOnly: false, disconnect: true,
    args: { seconds: 'integer 0..300' },
    validate: args => ({ seconds: requireInteger(args, 'seconds', 0, 300) }),
    run: (manager, address, args) => manager.setAutoLock(address, args.seconds),
  }),
  command('lock.audio.get', 'Read keypad sound configuration.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    run: (manager, address) => manager.getAudio(address),
  }),
  command('lock.audio.set', 'Enable or disable keypad sound.', {
    risk: 'setting', readOnly: false, disconnect: true,
    args: { enabled: 'boolean' },
    validate: args => ({ enabled: requireBoolean(args, 'enabled') }),
    run: (manager, address, args) => manager.setAudio(address, args.enabled),
  }),
  command('lock.passage_mode.get', 'Read passage-mode schedules.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    run: (manager, address) => manager.getPassageMode(address),
  }),
  command('lock.passage_mode.set', 'Add a passage-mode schedule.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { data: '{type, weekOrDay, month, startHour, endHour}' },
    validate: args => ({ data: normalizePassageMode(args) }),
    run: (manager, address, args) => manager.setPassageMode(address, args.data),
  }),
  command('lock.passage_mode.delete', 'Delete a passage-mode schedule.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { data: '{type, weekOrDay, month, startHour, endHour}' },
    validate: args => ({ data: normalizePassageMode(args) }),
    run: (manager, address, args) => manager.deletePassageMode(address, args.data),
  }),
  command('lock.passage_mode.clear', 'Delete every passage-mode schedule.', {
    risk: 'destructive', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.clearPassageMode(address),
  }),
  command('lock.remote_unlock.get', 'Read the lock remote-unlock configuration bit.', {
    risk: 'read_only', readOnly: true, disconnect: true,
    run: (manager, address) => manager.getRemoteUnlock(address),
  }),
  command('lock.remote_unlock.set', 'Set the lock remote-unlock configuration bit.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { enabled: 'boolean' },
    validate: args => ({ enabled: requireBoolean(args, 'enabled') }),
    run: (manager, address, args) => manager.setRemoteUnlock(address, args.enabled),
  }),
  command('lock.proactive_logs.get', 'Read the local proactive-log-fetch preference.', {
    risk: 'read_only', readOnly: true, falseIsResult: true,
    run: (manager, address) => manager.getProactiveLogFetching(address),
  }),
  command('lock.proactive_logs.set', 'Set the local proactive-log-fetch preference.', {
    risk: 'local', readOnly: false,
    args: { enabled: 'boolean' },
    validate: args => ({ enabled: requireBoolean(args, 'enabled') }),
    run: (manager, address, args) => manager.setProactiveLogFetching(address, args.enabled),
  }),
  command('lock.credentials.get', 'Read all supported credential collections.', {
    risk: 'sensitive_read', readOnly: true, disconnect: true,
    args: { forceRefresh: 'optional boolean' },
    validate: args => ({ forceRefresh: optionalBoolean(args, 'forceRefresh') }),
    run: (manager, address, args) => manager.getCredentials(address, args.forceRefresh),
  }),
  command('credential.passcode.get', 'Read valid passcodes.', {
    risk: 'sensitive_read', readOnly: true, disconnect: true,
    args: { forceRefresh: 'optional boolean' },
    validate: args => ({ forceRefresh: optionalBoolean(args, 'forceRefresh') }),
    run: (manager, address, args) => manager.getPasscodes(address, args.forceRefresh),
  }),
  command('credential.passcode.add', 'Add a passcode.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { type: 'integer 1..4', passCode: '4..9 digits', startDate: 'optional YYYYMMDDHHmm', endDate: 'optional YYYYMMDDHHmm' },
    validate: args => ({
      type: requireInteger(args, 'type', 1, 4),
      passCode: requireString(args, 'passCode', PASSCODE_PATTERN, 'passCode (4..9 digits)'),
      startDate: optionalString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: optionalString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
    }),
    run: (manager, address, args) => manager.addPasscode(address, args.type, args.passCode, args.startDate, args.endDate),
  }),
  command('credential.passcode.update', 'Update a passcode.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { type: 'integer 1..4', oldPassCode: '4..9 digits', newPassCode: '4..9 digits', startDate: 'optional YYYYMMDDHHmm', endDate: 'optional YYYYMMDDHHmm' },
    validate: args => ({
      type: requireInteger(args, 'type', 1, 4),
      oldPassCode: requireString(args, 'oldPassCode', PASSCODE_PATTERN, 'oldPassCode (4..9 digits)'),
      newPassCode: requireString(args, 'newPassCode', PASSCODE_PATTERN, 'newPassCode (4..9 digits)'),
      startDate: optionalString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: optionalString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
    }),
    run: (manager, address, args) => manager.updatePasscode(
      address, args.type, args.oldPassCode, args.newPassCode, args.startDate, args.endDate,
    ),
  }),
  command('credential.passcode.delete', 'Delete one passcode.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { type: 'integer 1..4', passCode: '4..9 digits' },
    validate: args => ({
      type: requireInteger(args, 'type', 1, 4),
      passCode: requireString(args, 'passCode', PASSCODE_PATTERN, 'passCode (4..9 digits)'),
    }),
    run: (manager, address, args) => manager.deletePasscode(address, args.type, args.passCode),
  }),
  command('credential.passcode.clear', 'Delete every passcode.', {
    risk: 'destructive', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.clearPasscodes(address),
  }),
  command('credential.card.get', 'Read valid IC cards.', {
    risk: 'sensitive_read', readOnly: true, disconnect: true,
    args: { forceRefresh: 'optional boolean' },
    validate: args => ({ forceRefresh: optionalBoolean(args, 'forceRefresh') }),
    run: (manager, address, args) => manager.getCards(address, args.forceRefresh),
  }),
  command('credential.card.add', 'Add or enroll an IC card.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { startDate: 'YYYYMMDDHHmm', endDate: 'YYYYMMDDHHmm', cardNumber: 'optional known card number', alias: 'optional string' },
    validate: args => ({
      startDate: requireString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: requireString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
      cardNumber: optionalString(args, 'cardNumber'),
      alias: optionalString(args, 'alias'),
    }),
    run: (manager, address, args) => manager.addCard(
      address, args.startDate, args.endDate, args.alias, args.cardNumber,
    ),
  }),
  command('credential.card.update', 'Update an IC card validity interval.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { cardNumber: 'string', startDate: 'YYYYMMDDHHmm', endDate: 'YYYYMMDDHHmm', alias: 'optional string' },
    validate: args => ({
      cardNumber: requireString(args, 'cardNumber'),
      startDate: requireString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: requireString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
      alias: optionalString(args, 'alias'),
    }),
    run: (manager, address, args) => manager.updateCard(
      address, args.cardNumber, args.startDate, args.endDate, args.alias,
    ),
  }),
  command('credential.card.delete', 'Delete one IC card.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { cardNumber: 'string' },
    validate: args => ({ cardNumber: requireString(args, 'cardNumber') }),
    run: (manager, address, args) => manager.deleteCard(address, args.cardNumber),
  }),
  command('credential.card.clear', 'Delete every IC card.', {
    risk: 'destructive', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.clearCards(address),
  }),
  command('credential.fingerprint.get', 'Read valid fingerprints.', {
    risk: 'sensitive_read', readOnly: true, disconnect: true,
    args: { forceRefresh: 'optional boolean' },
    validate: args => ({ forceRefresh: optionalBoolean(args, 'forceRefresh') }),
    run: (manager, address, args) => manager.getFingers(address, args.forceRefresh),
  }),
  command('credential.fingerprint.add', 'Enroll a fingerprint.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { startDate: 'YYYYMMDDHHmm', endDate: 'YYYYMMDDHHmm', alias: 'optional string' },
    validate: args => ({
      startDate: requireString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: requireString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
      alias: optionalString(args, 'alias'),
    }),
    run: (manager, address, args) => manager.addFinger(address, args.startDate, args.endDate, args.alias),
  }),
  command('credential.fingerprint.update', 'Update fingerprint validity.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { fpNumber: 'string', startDate: 'YYYYMMDDHHmm', endDate: 'YYYYMMDDHHmm', alias: 'optional string' },
    validate: args => ({
      fpNumber: requireString(args, 'fpNumber'),
      startDate: requireString(args, 'startDate', DATE_PATTERN, 'startDate (YYYYMMDDHHmm)'),
      endDate: requireString(args, 'endDate', DATE_PATTERN, 'endDate (YYYYMMDDHHmm)'),
      alias: optionalString(args, 'alias'),
    }),
    run: (manager, address, args) => manager.updateFinger(
      address, args.fpNumber, args.startDate, args.endDate, args.alias,
    ),
  }),
  command('credential.fingerprint.delete', 'Delete one fingerprint.', {
    risk: 'security', readOnly: false, confirmationRequired: true, disconnect: true,
    args: { fpNumber: 'string' },
    validate: args => ({ fpNumber: requireString(args, 'fpNumber') }),
    run: (manager, address, args) => manager.deleteFinger(address, args.fpNumber),
  }),
  command('credential.fingerprint.clear', 'Delete every fingerprint.', {
    risk: 'destructive', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.clearFingers(address),
  }),
  command('lock.operations.get', 'Read the operation log.', {
    risk: 'sensitive_read', readOnly: true, disconnect: true,
    args: { forceRefresh: 'optional boolean' },
    validate: args => ({ forceRefresh: optionalBoolean(args, 'forceRefresh') }),
    run: (manager, address, args) => manager.getOperationLog(address, args.forceRefresh),
  }),
  command('lock.reset', 'Factory-reset and unpair the lock.', {
    risk: 'destructive', readOnly: false, confirmationRequired: true, disconnect: true,
    run: (manager, address) => manager.resetLock(address),
  }),
]);

class CommandApi {
  constructor(manager) {
    this.manager = manager;
    this.commands = new Map(COMMANDS.map(item => [item.name, item]));
  }

  getCapabilities() {
    return COMMANDS.map(item => ({
      name: item.name,
      description: item.description,
      risk: item.risk,
      readOnly: item.readOnly,
      requiresAddress: item.requiresAddress !== false,
      confirmationRequired: item.confirmationRequired === true,
      autoDisconnect: item.disconnect === true,
      args: item.args || {},
    }));
  }

  async execute(payload) {
    const request = requireObject(payload, 'command data');
    const name = requireString(request, 'name');
    const definition = this.commands.get(name);
    if (!definition) fail(`Unsupported command: ${name}`);

    const requiresAddress = definition.requiresAddress !== false;
    const address = requiresAddress
      ? requireString(request, 'address', ADDRESS_PATTERN, 'address (AA:BB:CC:DD:EE:FF)').toUpperCase()
      : undefined;
    const args = request.args === undefined ? {} : requireObject(request.args, 'args');
    const normalizedArgs = definition.validate ? definition.validate(args) : args;

    if (definition.confirmationRequired) {
      const expected = `${name} ${address}`;
      if (request.confirm !== expected) {
        fail(`Command requires exact confirmation: ${expected}`);
      }
    }

    try {
      const result = await definition.run(this.manager, address, normalizedArgs);
      if (result === false && definition.falseIsResult !== true) fail(`Command failed: ${name}`);
      return {
        name,
        address,
        success: true,
        result,
        risk: definition.risk,
        readOnly: definition.readOnly,
      };
    } finally {
      if (definition.disconnect === true && address) {
        await this.manager.disconnectLock(address);
      }
    }
  }
}

module.exports = CommandApi;
module.exports.COMMANDS = COMMANDS;
module.exports.DEVICE_INFO_TYPES = DEVICE_INFO_TYPES;
