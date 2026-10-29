// Training-only non-payment Cancellation notices. No policy or Billing state is changed here.
import { createHash } from 'node:crypto';

export const CANCELLATION_NOTICE_TYPE = 'NON_PAYMENT_CANCELLATION_NOTICE';
export const CANCELLATION_NAMESPACE = 'NPC_NOTICE';
export const REQUIRED = ['requestId', 'policyId', 'customerRef', 'noticeId', 'noticeSnapshotId'];
const identifier = value => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 160 && !/[\r\n\x00-\x1f]/.test(value);
export function validateCancellationRequest(payload, attachments = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'VALIDATION_FAILED', message: 'A JSON metadata object is required.' };
  const missing = REQUIRED.filter(k => !identifier(payload[k]));
  if (missing.length) return { error: 'VALIDATION_FAILED', message: 'Missing or invalid identity fields.', missing };
  if (payload.messageType && payload.messageType !== CANCELLATION_NOTICE_TYPE) return { error: 'MESSAGE_TYPE_MISMATCH', message: 'Only non-payment Cancellation notices are supported.' };
  if (!payload.recipient || typeof payload.recipient !== 'object' || typeof payload.recipient.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.recipient.email) || payload.recipient.email.length > 254) {
    return { error: 'VALIDATION_FAILED', message: 'A valid recipient.email is required.' };
  }
  if (!identifier(payload.subject) || typeof payload.body?.plainText !== 'string' ||
      !payload.body.plainText.trim() || payload.body.plainText.length > 20000) {
    return { error: 'NOTICE_CONTENT_REQUIRED', message: 'An explicit subject and plain-text notice body are required; this API does not invent legal notice content.' };
  }
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(payload.body.plainText) || /\b\d{3}-\d{2}-\d{4}\b/.test(payload.subject)) {
    return { error: 'SENSITIVE_CONTENT_PROHIBITED', message: 'Do not include SSN-formatted data in notice content.' };
  }
  if (attachments.length && (!identifier(payload.formsPackageId) || !identifier(payload.formsPackageSnapshotId))) {
    return { error: 'PACKAGE_CORRELATION_REQUIRED', message: 'PDF notices require formsPackageId and formsPackageSnapshotId.' };
  }
  if (payload.resend !== true && (payload.resend != null && payload.resend !== false || payload.originalMessageId != null || payload.resendReason != null || payload.resendActor != null)) {
    return { error: 'RESEND_PROVENANCE_REQUIRED', message: 'Resend identity fields are only permitted for an explicit controlled resend.' };
  }
  if (payload.resend === true && (!identifier(payload.originalMessageId) || !identifier(payload.resendReason) || !identifier(payload.resendActor))) {
    return { error: 'RESEND_PROVENANCE_REQUIRED', message: 'Controlled resend requires originalMessageId, resendReason, and resendActor.' };
  }
  return { ok: true };
}

/** The service must independently protect a resend, even when PAS UI checks are bypassed.
 * Identity, approved notice text and original Forms bytes are immutable; only
 * the new requestId and audited resend provenance may differ.
 */
export function validateControlledCancellationResend(payload, original, attachmentFingerprint = []) {
  if (!original || original.messageType !== CANCELLATION_NOTICE_TYPE ||
      original.integrationNamespace !== CANCELLATION_NAMESPACE ||
      original.messageId !== payload.originalMessageId ||
      original.policyId !== payload.policyId || original.customerRef !== payload.customerRef ||
      original.noticeId !== payload.noticeId || original.noticeSnapshotId !== payload.noticeSnapshotId) {
    return { error: 'RESEND_CORRELATION_MISMATCH', message: 'Original Cancellation notice identity does not match.' };
  }
  const previousStatus = String(original.emailDeliveryStatus || '').toUpperCase();
  if (!['FAILED', 'BOUNCED'].includes(previousStatus) || original.providerDelivery?.signatureVerified && original.providerDelivery?.providerEventType === 'email.delivered') {
    return { error: 'RESEND_NOT_ELIGIBLE', message: 'Only failed or bounced notices may be resent. Refresh provider delivery status first.' };
  }
  if (String(original.recipient?.email || '').toLowerCase().trim() !== payload.recipient.email.toLowerCase().trim() ||
      String(original.recipient?.name || '') !== String(payload.recipient.name || '').slice(0, 160) ||
      original.subject !== payload.subject || original.body?.plainText !== payload.body.plainText ||
      String(original.formsPackageId || '') !== String(payload.formsPackageId || '') ||
      String(original.formsPackageSnapshotId || '') !== String(payload.formsPackageSnapshotId || '')) {
    return { error: 'RESEND_CONTENT_MISMATCH', message: 'Controlled resend must preserve the exact frozen recipient, notice text and Forms package.' };
  }
  const previousFiles = (original.attachments || []).map(file => ({
    fileName: file.fileName, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256,
  }));
  if (JSON.stringify(previousFiles) !== JSON.stringify(attachmentFingerprint)) {
    return { error: 'RESEND_ATTACHMENT_MISMATCH', message: 'Controlled resend must preserve the exact frozen PDF bytes.' };
  }
  if (payload.requestId === original.requestId || payload.requestId === original.messageId) {
    return { error: 'RESEND_REQUEST_ID_CONFLICT', message: 'A resend requires a fresh requestId independent of the original.' };
  }
  return { ok: true };
}

export function cancellationRequestFingerprint(payload, attachmentFingerprint = []) {
  const input = {
    policyId: payload.policyId, customerRef: payload.customerRef, noticeId: payload.noticeId,
    noticeSnapshotId: payload.noticeSnapshotId, recipient: payload.recipient.email.toLowerCase().trim(),
    subject: payload.subject, body: payload.body.plainText,
    formsPackageId: payload.formsPackageId || null, formsPackageSnapshotId: payload.formsPackageSnapshotId || null,
    attachmentFingerprint,
    originalMessageId: payload.resend ? payload.originalMessageId : null,
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function cancellationDeliveryStatus(message) {
  const delivery = message.providerDelivery || {};
  const signed = delivery.signatureVerified === true;
  const delivered = message.emailDeliveryStatus === 'DELIVERED' && !message.resendSimulated &&
    message.deliveryMode === 'REAL_PROVIDER' && delivery.provider === 'RESEND' &&
    delivery.providerEventType === 'email.delivered' && Boolean(delivery.providerEventId) &&
    Boolean(message.providerMessageId) && Boolean(message.deliveredAt) &&
    Number.isFinite(Date.parse(message.deliveredAt)) && signed;
  return {
    messageId: message.messageId,
    requestId: message.requestId,
    policyId: message.policyId,
    noticeId: message.noticeId,
    noticeSnapshotId: message.noticeSnapshotId,
    messageType: CANCELLATION_NOTICE_TYPE,
    deliveryStatus: message.emailDeliveryStatus || 'UNKNOWN',
    deliveryMode: message.deliveryMode || 'UNKNOWN',
    acceptedAt: message.acceptedAt || null,
    formsDeliveryStatus: message.formsDelivery?.status || 'NOT_REQUESTED',
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    deliveryEvidenceVerified: delivered,
    // This is the exact PAS Phase C delivery-evidence shape; absent unless signed.
    notice: delivered ? {
      deliveryStatus: 'DELIVERED',
      deliveryEventId: delivery.providerEventId,
      externalMessageId: message.providerMessageId,
      provider: 'RESEND',
      deliveredAt: message.deliveredAt,
      evidenceSource: 'EXTERNAL_PROVIDER_DELIVERY_WEBHOOK',
    } : null,
  };
}
