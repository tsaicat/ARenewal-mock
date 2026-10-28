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
  if (payload.resend === true && (!identifier(payload.originalMessageId) || !identifier(payload.resendReason) || !identifier(payload.resendActor))) {
    return { error: 'RESEND_PROVENANCE_REQUIRED', message: 'Controlled resend requires originalMessageId, resendReason, and resendActor.' };
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
