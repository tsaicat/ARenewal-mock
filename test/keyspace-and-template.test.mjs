import test from 'node:test';
import assert from 'node:assert/strict';
import { arEmailKey, AUTO_RENEWAL_EMAIL_KEYSPACE } from '../lib/keyspace.js';
import { selectMilestone, buildRenewalEmail } from '../lib/templates.js';

test('all email service keys use the dedicated Upstash namespace', () => {
  assert.equal(AUTO_RENEWAL_EMAIL_KEYSPACE, 'ar-email:v1');
  assert.equal(arEmailKey('message', 'AR-EMAIL-MSG-1'), 'ar-email:v1:message:AR-EMAIL-MSG-1');
  assert.equal(arEmailKey('audit', 'log'), 'ar-email:v1:audit:log');
});

test('explicit 60/45/15 milestone always controls the server template', () => {
  for (const milestone of [60, 45, 15]) {
    assert.equal(selectMilestone({ noticeMilestone: milestone }), milestone);
    const email = buildRenewalEmail({
      sourcePolicyId: 'PA2027000001-00',
      recipient: { name: 'QA Customer' },
      offer: { noticeMilestone: milestone, offeredPremium: 1200 },
    });
    assert.equal(email.milestone, milestone);
    assert.match(email.subject, /PA2027000001-00/);
  }
});
