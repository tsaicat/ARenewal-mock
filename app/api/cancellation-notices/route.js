import { NextResponse } from 'next/server';
import { securePasWrite } from '@/lib/routeSecurity';
import { getMessage, saveMessage, updateMessage } from '@/lib/messages';
import { sendRenewalEmail } from '@/lib/resend';
import { recordAudit } from '@/lib/audit';
import { kvGet, kvSetIfAbsent, kvDelete, kvSet } from '@/lib/store';
import { arEmailKey } from '@/lib/keyspace';
import { newId } from '@/lib/ids';
import { stripPrivacyFields, findPrivacyFieldsPresent } from '@/lib/privacy';
import { AttachmentValidationError, attachmentRequestFingerprint, prepareUploadedAttachments,
  storeAttachment, deleteAttachment, markAttachmentDelivery } from '@/lib/attachments';
import { validateCancellationRequest, cancellationRequestFingerprint, cancellationDeliveryStatus,
  CANCELLATION_NOTICE_TYPE, CANCELLATION_NAMESPACE, validateControlledCancellationResend } from '@/lib/cancellationNotices';
import { classifyStorageError } from '@/lib/storageErrors';

export const dynamic = 'force-dynamic';
const fail = (code, message, status=400, additional={}) => NextResponse.json({ code, error: message, ...additional }, {status});
export async function OPTIONS() { return new NextResponse(null, {status:204}); }

async function parse(req) {
  const type = String(req.headers.get('content-type') || '').toLowerCase();
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const raw = form.get('metadata');
    if (typeof raw !== 'string') throw new AttachmentValidationError('VALIDATION_FAILED','Multipart metadata JSON field is required.');
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new AttachmentValidationError('VALIDATION_FAILED', 'Invalid metadata JSON.'); }
    const files = [];
    for (const [key, value] of form.entries()) {
      if (['attachment','attachments'].includes(key) && value && typeof value.arrayBuffer === 'function') files.push(value);
    }
    return { payload, attachments: files.length ? await prepareUploadedAttachments(files) : [], mode: 'multipart/form-data' };
  }
  if (type.includes('application/json')) return { payload: await req.json(), attachments: [], mode: 'application/json' };
  throw new AttachmentValidationError('UNSUPPORTED_CONTENT_TYPE','Use application/json or multipart/form-data.',415);
}
const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function POST(req) {
  const access = await securePasWrite(req, 'send', 'SEND_CANCELLATION_NOTICE');
  if (!access.ok) return access.response;
  let incoming;
  try { incoming = await parse(req); }
  catch (error) { return fail(error.code || 'VALIDATION_FAILED',error.message || 'Unable to parse request.',error.status || 400); }
  const { attachments, mode } = incoming;
  const validation = validateCancellationRequest(incoming.payload, attachments);
  if (!validation.ok) return fail(validation.error, validation.message, 400, validation.missing ? {missing: validation.missing} : {});
  // Only a strictly selected set of notice metadata goes into long-term storage.
  const payload = stripPrivacyFields(incoming.payload);
  const fingerprint = cancellationRequestFingerprint(payload, attachmentRequestFingerprint(attachments));
  const requestKey = arEmailKey('cancellation-request', payload.requestId);
  const resultKey = arEmailKey('cancellation-request-result', payload.requestId);
  const first = await kvSetIfAbsent(requestKey, { fingerprint });
  if (!first) {
    const existing = await kvGet(requestKey);
    if (existing?.fingerprint !== fingerprint) return fail('IDEMPOTENCY_CONFLICT','requestId is associated with different notice content.',409);
    const priorId = await kvGet(resultKey);
    if (!priorId) return fail('REQUEST_IN_PROGRESS','This request is still processing.',409);
    const prior = await getMessage(priorId);
    if (!prior) return fail('MESSAGE_EXPIRED','Existing message has expired; use a new requestId.',410);
    // Legacy requestId fingerprints do not include resend provenance. Verify it
    // from the persisted message before returning an idempotent success.
    if (payload.resend === true && (prior.resendOfMessageId !== payload.originalMessageId ||
        prior.resendReason !== payload.resendReason || prior.resendActor !== payload.resendActor))
      return fail('IDEMPOTENCY_CONFLICT', 'requestId is associated with different resend provenance.', 409);
    return NextResponse.json({ ...cancellationDeliveryStatus(prior), duplicate: true }, {status:200});
  }

  let original = null;
  if (payload.resend) {
    original = await getMessage(payload.originalMessageId);
    const resendValidation = validateControlledCancellationResend(payload, original, attachmentRequestFingerprint(attachments));
    if (!resendValidation.ok) {
      await kvDelete(requestKey);
      return fail(resendValidation.error, resendValidation.message, 409);
    }
  }
  const semanticKey = arEmailKey('cancellation-snapshot', encodeURIComponent(payload.policyId), encodeURIComponent(payload.noticeSnapshotId));
  if (!original) {
    const reserved = await kvSetIfAbsent(semanticKey, { requestId: payload.requestId, status: 'PROCESSING' });
    if (!reserved) {
      const current = await kvGet(semanticKey);
      const existing = current?.messageId ? await getMessage(current.messageId) : null;
      await kvDelete(requestKey);
      if (existing) return fail('NOTICE_ALREADY_SENT','This policy and frozen notice already have an outbound attempt. Failed or bounced attempts require controlled resend.',409,{messageId:existing.messageId});
      return fail('NOTICE_IN_PROGRESS','This policy and notice snapshot are being processed.',409);
    }
  }
  const messageId = newId('NPC-MSG');
  const threadId = original?.threadId || newId('NPC-THREAD');
  const storedAttachments = [];
  let messagePersisted = false;
  try {
    for (const file of attachments) storedAttachments.push(await storeAttachment(file, {
      messageId, offerNumber: null, formsPackageId: payload.formsPackageId, formsPackageSnapshotId: payload.formsPackageSnapshotId,
    }));
    const result = await sendRenewalEmail({
      to: payload.recipient.email, subject: payload.subject, text: payload.body.plainText,
      html: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(payload.body.plainText)}</div>`,
      messageId: null, senderName: 'Policy Notices', attachments,
      headers: { 'X-PAS-Policy-Id': payload.policyId, 'X-PAS-Notice-Id':payload.noticeId, 'X-PAS-Notice-Snapshot-Id':payload.noticeSnapshotId,
        ...(payload.formsPackageSnapshotId ? {'X-Forms-Package-Snapshot-Id':payload.formsPackageSnapshotId} : {}) },
    });
    const sent = Boolean(result.ok);
    const simulated = Boolean(result.simulated);
    const emailDeliveryStatus = sent ? simulated ? 'SIMULATED' : 'DELIVERY_PENDING' : 'FAILED';
    const deliveryMode = result.deliveryMode || (simulated ? 'SIMULATED' : 'REAL_PROVIDER');
    const stamped = new Date().toISOString();
    const attachmentsUpdated = await Promise.all(storedAttachments.map(a => markAttachmentDelivery(a.attachmentId,
      !sent ? 'DELIVERY_FAILED' : simulated ? 'SIMULATED' : 'DELIVERY_PENDING')));
    const formsDelivery = attachments.length ? { status:emailDeliveryStatus, attachmentCount:attachments.length,
      attachmentIds:storedAttachments.map(a=>a.attachmentId), formsPackageId:payload.formsPackageId,
      formsPackageSnapshotId:payload.formsPackageSnapshotId, deliveredAt:null } : {status:'NOT_REQUESTED',attachmentCount:0,attachmentIds:[]};
    const message = {
      messageId, threadId, requestId:payload.requestId, messageType:CANCELLATION_NOTICE_TYPE,
      integrationNamespace:CANCELLATION_NAMESPACE, communicationType:'NOTICE',
      policyId:payload.policyId, sourcePolicyId:payload.policyId, customerRef:payload.customerRef,
      noticeId:payload.noticeId, noticeSnapshotId:payload.noticeSnapshotId,
      recipient:{email:payload.recipient.email, name:String(payload.recipient.name || '').slice(0,160)},
      subject:payload.subject, body:{plainText:payload.body.plainText}, requestMode:mode,
      status:sent?'SENT':'FAILED', emailDeliveryStatus, deliveryMode,
      acceptedAt: sent?stamped:null, createdAt:stamped, deliveredAt:null,
      providerMessageId:sent && !simulated ? result.id || null : null,
      providerDelivery:{provider:'RESEND',providerMessageId:sent && !simulated?result.id || null:null,
        providerEventId:null,providerEventType:null,signatureVerified:false},
      resendSimulated:simulated, resendError:sent?null:result.error,
      resendOfMessageId:original?.messageId || null,
      resendReason:original?payload.resendReason:null, resendActor:original?payload.resendActor:null,
      formsPackageId:payload.formsPackageId || null, formsPackageSnapshotId:payload.formsPackageSnapshotId || null,
      attachments:attachmentsUpdated, formsDelivery,
      privacyFieldsStripped:findPrivacyFieldsPresent(incoming.payload),
    };
    await saveMessage(message);
    messagePersisted = true;
    await kvSet(resultKey, messageId);
    if (!original) {
      // A failed attempt is still a real outbound attempt with a durable message.
      // Do not permit a new untracked 'first send' for the same frozen snapshot.
      await kvSet(semanticKey,{requestId:payload.requestId,messageId,status: sent ? 'SENT' : 'FAILED'});
    } else {
      // The resend has its own immutable message and resendOfMessageId. If the
      // original's count cannot be refreshed, never discard the new evidence.
      await updateMessage(original.messageId, {resendCount:Number(original.resendCount||0)+1,lastResentAt:stamped}).catch(()=>{});
    }
    await recordAudit(sent?'CANCELLATION_NOTICE_ACCEPTED':'CANCELLATION_NOTICE_SEND_FAILED',{
      messageId, policyId:payload.policyId, noticeId:payload.noticeId, noticeSnapshotId:payload.noticeSnapshotId,
      providerMessageId:message.providerMessageId, emailDeliveryStatus, attachmentCount:attachments.length,
      resendOfMessageId:original?.messageId||null, resendActor: original ? payload.resendActor : null,
    }).catch(()=>{});
    return NextResponse.json({ ...cancellationDeliveryStatus(message), duplicate:false }, {status:sent?201:502});
  } catch (error) {
    // Once the message was persisted, the provider may already have sent its
    // bytes: deleting its PDF/request identity would corrupt delivery lineage.
    if (messagePersisted) {
      await kvSet(resultKey, messageId).catch(()=>{});
      if (!original) await kvSet(semanticKey,{requestId:payload.requestId,messageId,status:'FINALIZATION_RETRY'}).catch(()=>{});
      await recordAudit('CANCELLATION_NOTICE_FINALIZATION_INCOMPLETE', {messageId, policyId:payload.policyId}).catch(()=>{});
      return fail('NOTICE_FINALIZATION_INCOMPLETE','The outbound message was recorded, but some status indexes could not be finalized. Retry the same requestId; do not create a new notice.',503,{messageId});
    }
    await Promise.allSettled(storedAttachments.map(a=>deleteAttachment(a.attachmentId)));
    await kvDelete(requestKey).catch(()=>{});
    if (!original) await kvDelete(semanticKey).catch(()=>{});
    const issue=classifyStorageError(error);
    await recordAudit('CANCELLATION_NOTICE_PROCESSING_FAILED', {messageId, policyId:payload.policyId, code:issue.code}).catch(()=>{});
    return fail(issue.code,issue.message,503);
  }
}
