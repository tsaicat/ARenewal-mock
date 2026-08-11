import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySvixSignature, WEBHOOK_TOLERANCE_SECONDS } from '../lib/webhookSignature.js';

const rawBody = JSON.stringify({ type: 'email.received', data: { email_id: 'em_123' } });
const id = 'msg_test';
const timestamp = 1786464000;
const secretBytes = Buffer.from('unit-test-webhook-secret');
const secret = `whsec_${secretBytes.toString('base64')}`;
const signatureValue = createHmac('sha256', secretBytes)
  .update(`${id}.${timestamp}.${rawBody}`)
  .digest('base64');

test('Svix signature verification accepts a valid v1 signature', () => {
  assert.equal(verifySvixSignature({
    rawBody,
    id,
    timestamp: String(timestamp),
    signature: `v1,${signatureValue}`,
    secret,
    nowMs: timestamp * 1000,
  }), true);
});

test('Svix signature verification rejects altered payloads', () => {
  assert.throws(() => verifySvixSignature({
    rawBody: `${rawBody} `,
    id,
    timestamp: String(timestamp),
    signature: `v1,${signatureValue}`,
    secret,
    nowMs: timestamp * 1000,
  }), /Invalid webhook signature/);
});

test('Svix signature verification rejects stale timestamps', () => {
  assert.throws(() => verifySvixSignature({
    rawBody,
    id,
    timestamp: String(timestamp),
    signature: `v1,${signatureValue}`,
    secret,
    nowMs: (timestamp + WEBHOOK_TOLERANCE_SECONDS + 1) * 1000,
  }), /outside the allowed tolerance/);
});
