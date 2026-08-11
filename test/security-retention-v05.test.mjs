import test from 'node:test';
import assert from 'node:assert/strict';
import { kvGet, kvSet, kvIncrementWithExpiry, kvDelete } from '../lib/store.js';
import { retentionDays } from '../lib/environment.js';
import { internalCallbackToken, verifyInternalCallback } from '../lib/internalCallback.js';
import { classifyStorageError } from '../lib/storageErrors.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('local storage TTL removes retained records after expiry', async () => {
  const key = `ar-email:v1:test-ttl:${Date.now()}`;
  await kvSet(key, { ok: true }, { ttlSeconds: 0.03 });
  assert.deepEqual(await kvGet(key), { ok: true });
  await sleep(45);
  assert.equal(await kvGet(key), null);
});

test('server-side rate counter persists within its TTL window', async () => {
  const key = `ar-email:v1:test-rate:${Date.now()}`;
  assert.equal(await kvIncrementWithExpiry(key, 1), 1);
  assert.equal(await kvIncrementWithExpiry(key, 1), 2);
  await kvDelete(key);
});

test('retention period is explicit and bounded', () => {
  const prior = process.env.MOCK_DATA_RETENTION_DAYS;
  try {
    process.env.MOCK_DATA_RETENTION_DAYS = '45';
    assert.equal(retentionDays(), 45);
    process.env.MOCK_DATA_RETENTION_DAYS = '99999';
    assert.equal(retentionDays(), 30);
  } finally {
    if (prior === undefined) delete process.env.MOCK_DATA_RETENTION_DAYS; else process.env.MOCK_DATA_RETENTION_DAYS = prior;
  }
});

test('internal callback uses server-side HMAC and production fails closed without secrets', () => {
  const prior = { mode: process.env.MOCK_ENV_MODE, internal: process.env.MOCK_INTERNAL_CALLBACK_SECRET, qa: process.env.QA_SESSION_SECRET, api: process.env.MOCK_API_KEY };
  try {
    delete process.env.MOCK_INTERNAL_CALLBACK_SECRET; delete process.env.QA_SESSION_SECRET; delete process.env.MOCK_API_KEY;
    process.env.MOCK_ENV_MODE = 'development';
    const devToken = internalCallbackToken('EVT-1');
    assert.ok(devToken);
    assert.equal(verifyInternalCallback({ headers: { get: (name) => name === 'x-mock-internal-callback' ? devToken : null } }, 'EVT-1'), true);
    process.env.MOCK_ENV_MODE = 'production';
    assert.equal(internalCallbackToken('EVT-1'), '');
    assert.equal(verifyInternalCallback({ headers: { get: () => '' } }, 'EVT-1'), false);
  } finally {
    for (const [k,v] of Object.entries({MOCK_ENV_MODE:prior.mode, MOCK_INTERNAL_CALLBACK_SECRET:prior.internal, QA_SESSION_SECRET:prior.qa, MOCK_API_KEY:prior.api})) {
      if (v === undefined) delete process.env[k]; else process.env[k]=v;
    }
  }
});

test('storage failures are mapped to safe actionable codes', () => {
  assert.equal(classifyStorageError(new Error('Upstash maxmemory quota exceeded')).code, 'STORAGE_QUOTA_EXCEEDED');
  assert.equal(classifyStorageError(new Error('redis network unavailable')).code, 'STORAGE_UNAVAILABLE');
  assert.equal(classifyStorageError(new Error('unknown write failure')).code, 'ATTACHMENT_STORAGE_FAILED');
});
