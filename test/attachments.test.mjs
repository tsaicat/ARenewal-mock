import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ATTACHMENT_LIMITS,
  AttachmentValidationError,
  attachmentRequestFingerprint,
  prepareUploadedAttachments,
  sanitizeAttachmentFileName,
} from '../lib/attachments.js';

function upload(name, type, bytes) {
  return {
    name,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test('actual PDF bytes are accepted, hashed, and never reduced to metadata-only input', async () => {
  const pdf = await readFile(new URL('../postman/fixtures/renewal-forms-sample.pdf', import.meta.url));
  const [attachment] = await prepareUploadedAttachments([upload('../unsafe/renewal.pdf', 'application/pdf', pdf)]);
  assert.equal(attachment.fileName, 'renewal.pdf');
  assert.equal(attachment.contentType, 'application/pdf');
  assert.equal(attachment.sizeBytes, pdf.length);
  assert.ok(attachment.contentBase64.length > pdf.length);
  assert.match(attachment.checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(attachmentRequestFingerprint([attachment])[0].checksumSha256, attachment.checksumSha256);
});

test('fake PDF MIME without PDF signature is rejected', async () => {
  await assert.rejects(
    () => prepareUploadedAttachments([upload('fake.pdf', 'application/pdf', Buffer.from('not a pdf'))]),
    (error) => error instanceof AttachmentValidationError && error.code === 'UNSUPPORTED_ATTACHMENT_TYPE'
  );
});

test('attachment limits and path-safe filenames are explicit', () => {
  assert.equal(ATTACHMENT_LIMITS.maxCount, 3);
  assert.equal(ATTACHMENT_LIMITS.maxBytesPerFile, 3 * 1024 * 1024);
  assert.equal(ATTACHMENT_LIMITS.maxTotalBytes, 3 * 1024 * 1024);
  assert.deepEqual(ATTACHMENT_LIMITS.allowedContentTypes, ['application/pdf']);
  assert.equal(sanitizeAttachmentFileName('../../bad:name.pdf'), 'bad_name.pdf');
});

test('stored attachment preserves the exact PDF bytes and delivery evidence', async () => {
  const {
    storeAttachment,
    getAttachment,
    markAttachmentDelivery,
    deleteAttachment,
  } = await import('../lib/attachments.js');
  const pdf = await readFile(new URL('../postman/fixtures/renewal-forms-sample.pdf', import.meta.url));
  const [attachment] = await prepareUploadedAttachments([upload('renewal-forms-sample.pdf', 'application/pdf', pdf)]);

  await storeAttachment(attachment, {
    messageId: 'AR-EMAIL-MSG-TEST',
    offerNumber: 'ARN-TEST',
    formsPackageId: 'ARN-FORMS-TEST',
    formsPackageSnapshotId: 'ARN-FORMS-TEST-S1',
  });

  const stored = await getAttachment(attachment.attachmentId);
  assert.ok(stored);
  assert.deepEqual(Buffer.from(stored.contentBase64, 'base64'), pdf);
  assert.equal(stored.deliveryStatus, 'STORED');

  const delivered = await markAttachmentDelivery(attachment.attachmentId, 'DELIVERED', '2026-08-11T12:00:00.000Z');
  assert.equal(delivered.deliveryStatus, 'DELIVERED');
  assert.equal(delivered.deliveredAt, '2026-08-11T12:00:00.000Z');

  await deleteAttachment(attachment.attachmentId);
  assert.equal(await getAttachment(attachment.attachmentId), null);
});
