'use strict';

const https = require('https');

const API_HOST = 'euapi.ttlock.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requestJson(path, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://${API_HOST}${path}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, String(value));
    }

    const request = https.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`TTLock API returned HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('TTLock API response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_error) {
          reject(new Error('TTLock API returned invalid JSON'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('TTLock API request timed out')));
    request.on('error', reject);
  });
}

async function fetchLockData({ clientId, accessToken, lockId, expectedMac }) {
  if (typeof clientId !== 'string' || clientId.length < 8) {
    throw new Error('TTLock client ID is missing');
  }
  if (typeof accessToken !== 'string' || accessToken.length < 16) {
    throw new Error('TTLock access token is missing');
  }
  if (!Number.isInteger(lockId) || lockId <= 0) {
    throw new Error('TTLock lock ID is invalid');
  }

  const result = await requestJson('/v3/lock/list', {
    clientId,
    accessToken,
    pageNo: 1,
    pageSize: 100,
    date: Date.now(),
  });
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`TTLock API rejected the request with code ${result.errcode}`);
  }
  if (!Array.isArray(result.list)) {
    throw new Error('TTLock API response did not contain a lock list');
  }

  const lock = result.list.find((item) => Number(item.lockId) === lockId);
  if (!lock) throw new Error('Requested TTLock lock was not present in the account');
  if (expectedMac && String(lock.lockMac || '').toUpperCase() !== expectedMac.toUpperCase()) {
    throw new Error('TTLock API lock MAC did not match the expected device');
  }
  if (typeof lock.lockData !== 'string' || lock.lockData.length === 0) {
    throw new Error('TTLock API lock record did not contain lockData');
  }

  return lock.lockData;
}

module.exports = { fetchLockData };
