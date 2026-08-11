import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply } from '../lib/classifier.js';
import { normalizeOfferLineage } from '../lib/offers.js';
import { communicationSemanticKey } from '../lib/communications.js';

test('classifier preserves clear intent and holds negated/conditional acceptance', () => {
  assert.equal(classifyReply('I accept.').classification, 'ACCEPT');
  assert.equal(classifyReply('Yes, renew.').classification, 'ACCEPT');
  assert.equal(classifyReply('Do not renew.').classification, 'DECLINE');
  for (const text of [
    'I cannot accept this.',
    "I don't accept this.",
    'I am not accepting this offer.',
    "I accepted another company's quote.",
    'Can you explain this before I accept?',
    'I might accept depending on the premium.',
  ]) {
    assert.equal(classifyReply(text).classification, 'AMBIGUOUS', text);
  }
});

test('offer lineage uses explicit correlation and never parses -R2 implicitly', () => {
  const explicit = normalizeOfferLineage({ offerNumber: 'ARN-X-R2', baseOfferNumber: 'ARN-X', offerVersion: 2, supersedesOfferNumber: 'ARN-X' });
  assert.equal(explicit.baseOfferNumber, 'ARN-X');
  assert.equal(explicit.offerVersion, 2);
  assert.equal(explicit.supersedesOfferNumber, 'ARN-X');

  const legacy = normalizeOfferLineage({ offerNumber: 'ARN-X-R2' });
  assert.equal(legacy.baseOfferNumber, 'ARN-X-R2');
  assert.equal(legacy.offerVersion, 1);
  assert.equal(legacy.supersedesOfferNumber, null);
});

test('semantic milestone key is stable across requestIds', () => {
  const identity = { baseOfferNumber: 'ARN-1001', offerVersion: 2, noticeMilestone: '60_DAY', communicationType: 'NOTICE' };
  assert.equal(communicationSemanticKey(identity), communicationSemanticKey({ ...identity }));
  assert.match(communicationSemanticKey(identity), /communication/);
});

test('email simulation is explicit and production fails closed', async () => {
  const { sendRenewalEmail } = await import('../lib/resend.js');
  const previous = {
    apiKey: process.env.RESEND_API_KEY,
    allow: process.env.ALLOW_SIMULATED_EMAIL,
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
  };
  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALLOW_SIMULATED_EMAIL;
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL_ENV;
    const disabled = await sendRenewalEmail({ to: 'qa@example.test', subject: 'x', html: '<p>x</p>', text: 'x' });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.error.code, 'EMAIL_PROVIDER_NOT_CONFIGURED');

    process.env.ALLOW_SIMULATED_EMAIL = 'true';
    const simulated = await sendRenewalEmail({ to: 'qa@example.test', subject: 'x', html: '<p>x</p>', text: 'x' });
    assert.equal(simulated.ok, true);
    assert.equal(simulated.simulated, true);
    assert.equal(simulated.deliveryMode, 'SIMULATED');

    process.env.NODE_ENV = 'production';
    const production = await sendRenewalEmail({ to: 'qa@example.test', subject: 'x', html: '<p>x</p>', text: 'x' });
    assert.equal(production.ok, false);
    assert.equal(production.error.code, 'EMAIL_PROVIDER_NOT_CONFIGURED');
  } finally {
    if (previous.apiKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous.apiKey;
    if (previous.allow === undefined) delete process.env.ALLOW_SIMULATED_EMAIL; else process.env.ALLOW_SIMULATED_EMAIL = previous.allow;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous.vercelEnv;
  }
});
