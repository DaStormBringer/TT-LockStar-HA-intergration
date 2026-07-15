'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  convertCloudLockData,
  mergeConvertedLockData,
  validateCloudLockData,
} = require('../src/cloudLockData');

const TEST_MAC = 'D3:58:7F:58:DE:B9';

function crc8MaximTableValue(index) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? ((crc >>> 1) ^ 0x8c) : (crc >>> 1);
  }
  return crc;
}

function encodeProtectedDecimal(value, trailer) {
  const input = Buffer.from(String(value), 'utf8');
  const mask = trailer ^ crc8MaximTableValue(input.length & 0xff);
  const encoded = Buffer.alloc(input.length + 1);
  for (let index = 0; index < input.length; index += 1) {
    encoded[index] = input[index] ^ mask;
  }
  encoded[encoded.length - 1] = trailer;
  const serialized = [...encoded].map((byte) => (byte > 127 ? byte - 256 : byte)).join(',');
  return Buffer.from(serialized, 'utf8').toString('base64');
}

function buildCloudLockData(overrides = {}) {
  const data = {
    lockName: 'Test fixture',
    lockMac: TEST_MAC,
    adminPwd: encodeProtectedDecimal(12345678, 0x47),
    lockKey: encodeProtectedDecimal(87654321, 0x91),
    aesKeyStr: '0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f',
    autoLockTime: 15,
    electricQuantity: 92,
    ...overrides,
  };
  const key = Buffer.from(TEST_MAC.slice(0, 9) + TEST_MAC.slice(10), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
    cipher.final(),
  ]);
  const macBytes = Buffer.from(TEST_MAC.replaceAll(':', ''), 'hex');
  return Buffer.concat([encrypted, macBytes]).toString('base64');
}

test('converts validated cloud lockData into the JavaScript SDK shape', () => {
  const converted = convertCloudLockData(buildCloudLockData());
  assert.deepEqual(converted, {
    address: TEST_MAC,
    battery: 92,
    rssi: -100,
    autoLockTime: 15,
    lockedStatus: -1,
    privateData: {
      aesKey: '000102030405060708090a0b0c0d0e0f',
      admin: { adminPs: 12345678, unlockKey: 87654321 },
    },
    operationLog: [],
    proactiveLogs: false,
  });
});

test('returns a non-secret validation summary', () => {
  assert.deepEqual(validateCloudLockData(buildCloudLockData(), TEST_MAC), {
    valid: true,
    address: TEST_MAC,
    format: 'ttlock-cloud-legacy',
    hasAesKey: true,
    hasAdminMaterial: true,
  });
});

test('rejects an expected-MAC mismatch', () => {
  assert.throws(
    () => validateCloudLockData(buildCloudLockData(), 'DC:47:11:85:94:2F'),
    /payload MAC does not match/,
  );
});

test('rejects malformed and tampered payloads', () => {
  assert.throws(() => convertCloudLockData('not base64'), /not valid base64/);
  const payload = Buffer.from(buildCloudLockData(), 'base64');
  payload[0] ^= 0xff;
  assert.throws(
    () => convertCloudLockData(payload.toString('base64')),
    /decryption failed|decrypted payload is not JSON/,
  );
});

test('rejects signed data without supported administrative fields', () => {
  assert.throws(
    () => convertCloudLockData(buildCloudLockData({ adminPwd: undefined, sign: 'fixture' })),
    /signed lockData without legacy administrative fields/,
  );
});

test('merges an imported lock without removing other stored locks', () => {
  const imported = convertCloudLockData(buildCloudLockData());
  const other = { address: '11:22:33:44:55:66', privateData: {} };
  const replaced = { ...imported, battery: 1 };

  const merged = mergeConvertedLockData([other, replaced], imported);

  assert.deepEqual(merged, [other, imported]);
});
