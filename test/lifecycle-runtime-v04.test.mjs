import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUploadedAttachments, storeAttachment, getAttachment } from '../lib/attachments.js';
import { saveMessage, getMessage } from '../lib/messages.js';
import { applyProviderDeliveryEvent } from '../lib/delivery.js';
import { registerOfferRevision, getOfferState } from '../lib/offers.js';
import { processReply } from '../lib/replyProcessor.js';
import { listFamilyResponseEvents } from '../lib/responses.js';
import { reserveNormalCommunication, completeNormalCommunication, releaseNormalCommunication } from '../lib/communications.js';

function upload(name = 'runtime.pdf') {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  return {
    name,
    type: 'application/pdf',
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function suffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('provider delivery webhook is the event that promotes email and Forms to DELIVERED', async () => {
  const id = suffix();
  const messageId = `AR-EMAIL-MSG-${id}`;
  const providerMessageId = `provider-${id}`;
  const offerNumber = `ARN-${id}`;
  const [prepared] = await prepareUploadedAttachments([upload()]);
  const attachment = await storeAttachment(prepared, {
    messageId,
    offerNumber,
    formsPackageId: `PKG-${id}`,
    formsPackageSnapshotId: `SNAP-${id}`,
  });

  await saveMessage({
    messageId,
    threadId: `THREAD-${id}`,
    requestId: `REQ-${id}`,
    offerNumber,
    baseOfferNumber: offerNumber,
    offerVersion: 1,
    status: 'SENT',
    emailDeliveryStatus: 'DELIVERY_PENDING',
    providerMessageId,
    attachments: [attachment],
    formsPackageId: `PKG-${id}`,
    formsPackageSnapshotId: `SNAP-${id}`,
    formsDelivery: { status: 'DELIVERY_PENDING', attachmentIds: [attachment.attachmentId], attachmentCount: 1 },
  });

  const event = {
    type: 'email.delivered',
    created_at: '2026-08-11T20:00:00.000Z',
    data: { email_id: providerMessageId },
  };
  const first = await applyProviderDeliveryEvent({ event, providerEventId: `evt-${id}` });
  assert.equal(first.emailDeliveryStatus, 'DELIVERED');
  assert.equal(first.formsDeliveryStatus, 'DELIVERED');

  const storedMessage = await getMessage(messageId);
  assert.equal(storedMessage.emailDeliveryStatus, 'DELIVERED');
  assert.equal(storedMessage.formsDelivery.status, 'DELIVERED');
  assert.equal(storedMessage.deliveredAt, '2026-08-11T20:00:00.000Z');
  const storedAttachment = await getAttachment(attachment.attachmentId);
  assert.equal(storedAttachment.deliveryStatus, 'DELIVERED');

  const duplicate = await applyProviderDeliveryEvent({ event, providerEventId: `evt-${id}` });
  assert.equal(duplicate.duplicate, true);
});

test('bounce/failure evidence cannot leave attached Forms delivered', async () => {
  const id = suffix();
  const messageId = `AR-EMAIL-MSG-${id}`;
  const providerMessageId = `provider-${id}`;
  const offerNumber = `ARN-${id}`;
  const [prepared] = await prepareUploadedAttachments([upload('bounce.pdf')]);
  const attachment = await storeAttachment(prepared, {
    messageId,
    offerNumber,
    formsPackageId: `PKG-${id}`,
    formsPackageSnapshotId: `SNAP-${id}`,
  });
  await saveMessage({
    messageId,
    threadId: `THREAD-${id}`,
    requestId: `REQ-${id}`,
    offerNumber,
    baseOfferNumber: offerNumber,
    offerVersion: 1,
    status: 'SENT',
    emailDeliveryStatus: 'DELIVERY_PENDING',
    providerMessageId,
    attachments: [attachment],
    formsPackageId: `PKG-${id}`,
    formsPackageSnapshotId: `SNAP-${id}`,
    formsDelivery: { status: 'DELIVERY_PENDING', attachmentIds: [attachment.attachmentId], attachmentCount: 1 },
  });

  await applyProviderDeliveryEvent({
    event: { type: 'email.bounced', created_at: '2026-08-11T20:01:00.000Z', data: { email_id: providerMessageId, bounce: { type: 'Permanent' } } },
    providerEventId: `evt-bounce-${id}`,
  });
  const stored = await getMessage(messageId);
  assert.equal(stored.emailDeliveryStatus, 'BOUNCED');
  assert.equal(stored.formsDelivery.status, 'FAILED');
  assert.notEqual(stored.formsDelivery.status, 'DELIVERED');
});

test('response to superseded offer preserves ACCEPT intent but is not applied to current revision', async () => {
  const id = suffix();
  const baseOfferNumber = `ARN-FAMILY-${id}`;
  const v1 = `${baseOfferNumber}-V1`;
  const v2 = `${baseOfferNumber}-V2`;
  await registerOfferRevision({ offerNumber: v1, baseOfferNumber, offerVersion: 1, supersedesOfferNumber: null, offerExpirationDate: null, responseDueDate: null, renewalEffectiveDate: null });
  await registerOfferRevision({ offerNumber: v2, baseOfferNumber, offerVersion: 2, supersedesOfferNumber: v1, offerExpirationDate: null, responseDueDate: null, renewalEffectiveDate: null });

  const messageId = `AR-EMAIL-MSG-${id}`;
  await saveMessage({
    messageId,
    threadId: `THREAD-${id}`,
    requestId: `REQ-${id}`,
    offerNumber: v1,
    baseOfferNumber,
    offerVersion: 1,
    formsPackageId: `PKG-${id}-V1`,
    formsPackageSnapshotId: `SNAP-${id}-V1`,
    responseToken: `TOKEN-${id}`,
    responseInstructions: { acceptKeywords: ['ACCEPT'], declineKeywords: ['DECLINE'] },
    sourcePolicyId: `POL-${id}`,
    customerRef: `CUST-${id}`,
    callback: { url: 'http://127.0.0.1:9/unreachable-test-callback' },
  });

  const first = await processReply({
    messageId,
    replyId: `REPLY-${id}`,
    from: 'qa@example.test',
    subject: 'Re: renewal',
    plainText: 'ACCEPT',
    receivedAt: '2026-08-11T20:02:00.000Z',
    rawSource: { test: true },
    requestUrl: 'http://localhost:3000/api/test',
  });
  assert.equal(first.reply.normalizedDecision, 'ACCEPTED');
  assert.equal(first.reply.responseApplicability, 'SUPERSEDED_OFFER');
  assert.equal(first.reply.appliedToCurrentOffer, false);
  assert.ok(first.reply.eventId.startsWith('AR-EMAIL-EVENT-'));
  assert.equal((await getOfferState(v2)).customerResponseStatus, 'Pending');

  const duplicate = await processReply({
    messageId,
    replyId: `REPLY-${id}`,
    from: 'qa@example.test',
    subject: 'Re: renewal',
    plainText: 'ACCEPT',
    receivedAt: '2026-08-11T20:02:00.000Z',
    rawSource: { test: true },
    requestUrl: 'http://localhost:3000/api/test',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reply.eventId, first.reply.eventId);

  const history = await listFamilyResponseEvents(baseOfferNumber);
  assert.equal(history.filter((row) => row.eventId === first.reply.eventId).length, 1);
});

test('late ACCEPT is preserved but does not reactivate expired offer', async () => {
  const id = suffix();
  const offerNumber = `ARN-LATE-${id}`;
  await registerOfferRevision({
    offerNumber,
    baseOfferNumber: offerNumber,
    offerVersion: 1,
    supersedesOfferNumber: null,
    offerExpirationDate: '2026-08-10T23:59:59.000Z',
    responseDueDate: null,
    renewalEffectiveDate: '2026-08-15',
  });
  const messageId = `AR-EMAIL-MSG-${id}`;
  await saveMessage({
    messageId,
    threadId: `THREAD-${id}`,
    requestId: `REQ-${id}`,
    offerNumber,
    baseOfferNumber: offerNumber,
    offerVersion: 1,
    offerExpirationDate: '2026-08-10T23:59:59.000Z',
    responseInstructions: { acceptKeywords: ['ACCEPT'] },
    callback: { url: 'http://127.0.0.1:9/unreachable-test-callback' },
  });
  const result = await processReply({
    messageId,
    replyId: `REPLY-LATE-${id}`,
    from: 'qa@example.test',
    subject: 'Re: renewal',
    plainText: 'ACCEPT',
    receivedAt: '2026-08-11T00:00:01.000Z',
    rawSource: { test: true },
    requestUrl: 'http://localhost:3000/api/test',
  });
  assert.equal(result.reply.normalizedDecision, 'ACCEPTED');
  assert.equal(result.reply.responseApplicability, 'LATE');
  assert.equal(result.reply.lateResponse, true);
  assert.equal(result.reply.appliedToCurrentOffer, false);
  assert.equal((await getOfferState(offerNumber)).offerStatus, 'EXPIRED');
  assert.equal((await getOfferState(offerNumber)).customerResponseStatus, 'Pending');
});

test('semantic milestone guard blocks a different requestId after one normal send completes', async () => {
  const id = suffix();
  const identity = { baseOfferNumber: `ARN-IDEMP-${id}`, offerVersion: 1, noticeMilestone: '60_DAY', communicationType: 'NOTICE' };
  const first = await reserveNormalCommunication(identity, `REQ-A-${id}`);
  assert.equal(first.reserved, true);
  await completeNormalCommunication(first.key, { messageId: `MSG-${id}` });
  const second = await reserveNormalCommunication(identity, `REQ-B-${id}`);
  assert.equal(second.reserved, false);
  assert.equal(second.record.messageId, `MSG-${id}`);
  // Cleanup the fixture key so repeated local verification doesn't accumulate business guards.
  await releaseNormalCommunication(first.key);
});

test('older provider event cannot downgrade newer delivery evidence', async () => {
  const id = suffix();
  const messageId = `AR-EMAIL-MSG-${id}`;
  const providerMessageId = `provider-${id}`;
  await saveMessage({
    messageId,
    threadId: `THREAD-${id}`,
    requestId: `REQ-${id}`,
    offerNumber: `ARN-${id}`,
    baseOfferNumber: `ARN-${id}`,
    offerVersion: 1,
    status: 'SENT',
    emailDeliveryStatus: 'DELIVERY_PENDING',
    providerMessageId,
    attachments: [],
    formsDelivery: { status: 'NOT_REQUESTED', attachmentIds: [], attachmentCount: 0 },
  });
  await applyProviderDeliveryEvent({
    event: { type: 'email.delivered', created_at: '2026-08-11T20:10:00.000Z', data: { email_id: providerMessageId } },
    providerEventId: `evt-delivered-${id}`,
  });
  const stale = await applyProviderDeliveryEvent({
    event: { type: 'email.sent', created_at: '2026-08-11T20:09:00.000Z', data: { email_id: providerMessageId } },
    providerEventId: `evt-sent-${id}`,
  });
  assert.equal(stale.stale, true);
  assert.equal((await getMessage(messageId)).emailDeliveryStatus, 'DELIVERED');
});
