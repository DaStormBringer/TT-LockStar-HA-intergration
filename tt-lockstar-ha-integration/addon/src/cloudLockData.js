'use strict';

const crypto = require('crypto');

const MAC_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

function fail(message) {
  throw new Error(`Invalid TTLock cloud lockData: ${message}`);
}

function normalizeMac(value) {
  if (typeof value !== 'string') fail('lockMac is missing');
  const mac = value.replace(/-/g, ':').toUpperCase();
  if (!MAC_PATTERN.test(mac)) fail('lockMac is malformed');
  return mac;
}

function strictBase64(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    fail(`${fieldName} is not valid base64`);
  }
  const normalized = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    fail(`${fieldName} is not valid base64`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== normalized) {
    fail(`${fieldName} is not canonical base64`);
  }
  return decoded;
}

function crc8MaximTableValue(index) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? ((crc >>> 1) ^ 0x8c) : (crc >>> 1);
  }
  return crc;
}

function decodeProtectedDecimal(value, fieldName) {
  const serialized = strictBase64(value, fieldName).toString('utf8');
  if (!/^-?\d+(,-?\d+)*$/.test(serialized)) {
    fail(`${fieldName} does not contain an encoded byte array`);
  }

  const parts = serialized.split(',');
  if (parts.length < 2 || parts.length > 256) {
    fail(`${fieldName} has an invalid encoded length`);
  }
  const encoded = Buffer.alloc(parts.length);
  for (let index = 0; index < parts.length; index += 1) {
    const number = Number(parts[index]);
    if (!Number.isInteger(number) || number < -128 || number > 255) {
      fail(`${fieldName} contains an out-of-range byte`);
    }
    encoded[index] = number & 0xff;
  }

  const outputLength = encoded.length - 1;
  const mask = encoded[encoded.length - 1] ^ crc8MaximTableValue(outputLength & 0xff);
  const decoded = Buffer.alloc(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    decoded[index] = encoded[index] ^ mask;
  }

  const text = decoded.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(decoded) || !/^\d{1,10}$/.test(text)) {
    fail(`${fieldName} did not decode to an unsigned decimal value`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) {
    fail(`${fieldName} is outside the supported 32-bit range`);
  }
  return number;
}

function decodeAesKey(value) {
  if (typeof value !== 'string') fail('aesKeyStr is missing');
  const parts = value.split(',');
  if (parts.length !== 16 || parts.some((part) => !/^[0-9A-F]{1,2}$/i.test(part))) {
    fail('aesKeyStr is not exactly 16 hexadecimal bytes');
  }
  return Buffer.from(parts.map((part) => Number.parseInt(part, 16))).toString('hex');
}

function decodeCloudLockData(value) {
  const packed = strictBase64(value, 'lockData');
  if (packed.length < 22) fail('payload is too short');

  const encrypted = packed.subarray(0, packed.length - 6);
  if (encrypted.length === 0 || encrypted.length % 16 !== 0) {
    fail('encrypted payload length is invalid');
  }

  const mac = [...packed.subarray(packed.length - 6)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
  const key = Buffer.from(mac.slice(0, 9) + mac.slice(10), 'utf8');

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (_error) {
    fail('AES decryption failed');
  }

  let decoded;
  try {
    decoded = JSON.parse(plaintext.toString('utf8'));
  } catch (_error) {
    fail('decrypted payload is not JSON');
  }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') {
    fail('decrypted payload is not an object');
  }
  if (decoded.sign && !decoded.adminPwd) {
    fail('signed lockData without legacy administrative fields is not supported yet');
  }
  if (normalizeMac(decoded.lockMac) !== mac) {
    fail('embedded and appended MAC addresses do not match');
  }
  return { decoded, mac };
}

function convertCloudLockData(value) {
  const { decoded, mac } = decodeCloudLockData(value);
  const adminPs = decodeProtectedDecimal(decoded.adminPwd, 'adminPwd');
  const unlockKey = decodeProtectedDecimal(decoded.lockKey, 'lockKey');
  const aesKey = decodeAesKey(decoded.aesKeyStr);

  return {
    address: mac,
    battery: Number.isInteger(decoded.electricQuantity) ? decoded.electricQuantity : -1,
    rssi: -100,
    autoLockTime: Number.isInteger(decoded.autoLockTime) ? decoded.autoLockTime : -1,
    lockedStatus: -1,
    privateData: {
      aesKey,
      admin: { adminPs, unlockKey },
    },
    operationLog: [],
    proactiveLogs: false,
  };
}

function validateCloudLockData(value, expectedMac) {
  const converted = convertCloudLockData(value);
  if (expectedMac && converted.address !== normalizeMac(expectedMac)) {
    fail('payload MAC does not match the requested lock');
  }
  return {
    valid: true,
    address: converted.address,
    format: 'ttlock-cloud-legacy',
    hasAesKey: converted.privateData.aesKey.length === 32,
    hasAdminMaterial: Number.isInteger(converted.privateData.admin.adminPs)
      && Number.isInteger(converted.privateData.admin.unlockKey),
  };
}

function mergeConvertedLockData(existing, converted) {
  if (!Array.isArray(existing)) fail('stored lock data is not an array');
  if (!converted || typeof converted !== 'object') fail('converted lock data is missing');
  const address = normalizeMac(converted.address);
  return [
    ...existing.filter((lock) => normalizeMac(lock.address) !== address),
    converted,
  ];
}

module.exports = {
  convertCloudLockData,
  decodeCloudLockData,
  mergeConvertedLockData,
  validateCloudLockData,
};
