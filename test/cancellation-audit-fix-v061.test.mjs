import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCancellationRequest, validateControlledCancellationResend, cancellationDeliveryStatus, CANCELLATION_NOTICE_TYPE, CANCELLATION_NAMESPACE } from '../lib/cancellationNotices.js';
import { applyProviderDeliveryEvent, outboundWebhookHttpStatus } from '../lib/delivery.js';
import { saveMessage, getMessage } from '../lib/messages.js';
import { prepareUploadedAttachments, attachmentRequestFingerprint } from '../lib/attachments.js';

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function fixture() {
  const pdf={ fileName:'NPC-HO-Forms.pdf',sizeBytes:500,checksumSha256:'a'.repeat(64) };
  const base={
    requestId:'NPC-REQ-NEW',policyId:'HO2026999999-00',customerRef:'ACADEMY-C-9',noticeId:'NPC-N-9',noticeSnapshotId:'NPC-FROZEN-9',
    recipient:{email:'trainee@example.test',name:'Synthetic Trainee'},subject:'Approved Notice: HO2026999999-00',
    body:{plainText:'Frozen approved Academy notice.'},formsPackageId:'NPC-PACK-9',formsPackageSnapshotId:'NPC-FORMS-FROZEN-9',
  };
  const original={
    ...base, messageId:'NPC-MSG-PREV',requestId:'NPC-REQ-PREV',messageType:CANCELLATION_NOTICE_TYPE,integrationNamespace:CANCELLATION_NAMESPACE,
    emailDeliveryStatus:'BOUNCED',deliveryMode:'REAL_PROVIDER',providerDelivery:{provider:'RESEND',providerEventType:'email.bounced',signatureVerified:true},attachments:[pdf],
  };
  return {original,pdf,request:{...base,requestId:'NPC-REQ-NEXT',resend:true,originalMessageId:original.messageId,resendActor:'UW-Academy',resendReason:'Provider bounce confirmed'}};
}

test('Provider independently accepts only an identical frozen FAILED/BOUNCED Cancellation resend',()=>{
  const {original,pdf,request}=fixture();
  assert.deepEqual(validateCancellationRequest(request,[pdf]),{ok:true});
  assert.deepEqual(validateControlledCancellationResend(request,original,[pdf]),{ok:true});
  assert.deepEqual(validateControlledCancellationResend(request,{...original,emailDeliveryStatus:'FAILED'},[pdf]),{ok:true});
});

test('Resend is prohibited while pending, simulated, delivered or when a signed delivered event exists',()=>{
  const {original,pdf,request}=fixture();
  for(const status of ['DELIVERY_PENDING','DELIVERY_DELAYED','SENT','DELIVERED','SIMULATED','UNKNOWN']) {
    assert.equal(validateControlledCancellationResend(request,{...original,emailDeliveryStatus:status},[pdf]).error,'RESEND_NOT_ELIGIBLE',status);
  }
  assert.equal(validateControlledCancellationResend(request,{...original,providerDelivery:{signatureVerified:true,providerEventType:'email.delivered'}},[pdf]).error,'RESEND_NOT_ELIGIBLE');
});

test('Resend rejects altered notice text, subject, recipient, recipient name and frozen Forms identities',()=>{
  const {original,pdf,request}=fixture();
  for(const change of [
    {body:{plainText:'An unauthorized edited notice'}},{subject:'Changed subject'},
    {recipient:{...request.recipient,email:'different@example.test'}},
    {recipient:{...request.recipient,name:'Different insured'}},
    {formsPackageId:'PKG-OTHER'},{formsPackageSnapshotId:'SNAP-OTHER'},
  ]) assert.equal(validateControlledCancellationResend({...request,...change},original,[pdf]).error,'RESEND_CONTENT_MISMATCH',JSON.stringify(change));
});

test('Resend rejects changed policy/customer/snapshot/namespace, altered PDF, and reused request identity',()=>{
  const {original,pdf,request}=fixture();
  for(const change of [{policyId:'OTHER'},{customerRef:'OTHER'},{noticeId:'OTHER'},{noticeSnapshotId:'OTHER'},{originalMessageId:'OTHER'}]) {
    assert.equal(validateControlledCancellationResend({...request,...change},original,[pdf]).error,'RESEND_CORRELATION_MISMATCH');
  }
  assert.equal(validateControlledCancellationResend(request,{...original,integrationNamespace:'RENEWAL'},[pdf]).error,'RESEND_CORRELATION_MISMATCH');
  assert.equal(validateControlledCancellationResend(request,original,[{...pdf,checksumSha256:'b'.repeat(64)}]).error,'RESEND_ATTACHMENT_MISMATCH');
  assert.equal(validateControlledCancellationResend({...request,requestId:original.requestId},original,[pdf]).error,'RESEND_REQUEST_ID_CONFLICT');
});

test('Resend fields are rejected without explicit resend:true; original JSON path stays compatible',()=>{
  const {request}=fixture();
  assert.equal(validateCancellationRequest({...request,resend:false},[]).error,'RESEND_PROVENANCE_REQUIRED');
  assert.equal(validateCancellationRequest({...request,resend:'true'},[]).error,'RESEND_PROVENANCE_REQUIRED');
  const {resend,originalMessageId,resendActor,resendReason,...initial}=request;
  assert.deepEqual(validateCancellationRequest(initial,[]),{ok:true});
});

test('Signed provider callback that races message persistence is retried, then certifies once saved',async()=>{
  const uid=id();const eventId=`sig-webhook-${uid}`;const messageId=`NPC-MSG-${uid}`;const providerId=`resend-${uid}`;
  const event={type:'email.delivered',created_at:'2026-10-29T12:00:00Z',data:{email_id:providerId}};
  const premature=await applyProviderDeliveryEvent({event,providerEventId:eventId,signatureVerified:true});
  assert.equal(premature.resolved,false);assert.equal(premature.retryable,true);
  assert.equal(outboundWebhookHttpStatus(premature),503);
  await saveMessage({messageId,requestId:`NPC-REQ-${uid}`,messageType:CANCELLATION_NOTICE_TYPE,integrationNamespace:CANCELLATION_NAMESPACE,
    policyId:'HO-1',noticeId:'NPC-N',noticeSnapshotId:'NPC-S',providerMessageId:providerId,
    deliveryMode:'REAL_PROVIDER',emailDeliveryStatus:'DELIVERY_PENDING',providerDelivery:{provider:'RESEND'},
    attachments:[],formsDelivery:{status:'NOT_REQUESTED'},createdAt:new Date().toISOString()});
  const applied=await applyProviderDeliveryEvent({event,providerEventId:eventId,signatureVerified:true});
  assert.equal(outboundWebhookHttpStatus(applied),200);
  assert.equal(applied.resolved,true);
  assert.equal(cancellationDeliveryStatus(await getMessage(messageId)).deliveryEvidenceVerified,true);
  const repeat=await applyProviderDeliveryEvent({event,providerEventId:eventId,signatureVerified:true});
  assert.equal(repeat.duplicate,true);assert.equal(outboundWebhookHttpStatus(repeat),200);
});

test('Malformed provider callback without email_id is rejected, not falsely acknowledged',async()=>{
  const result=await applyProviderDeliveryEvent({event:{type:'email.delivered',data:{}},providerEventId:`bad-${id()}`,signatureVerified:true});
  assert.equal(result.resolved,false);assert.equal(result.retryable,false);assert.equal(outboundWebhookHttpStatus(result),400);
});

test('Cancellation evidence cannot use a fabricated provider delivery timestamp',async()=>{
  const uid=id(), providerMessageId=`provider-${uid}`, messageId=`NPC-MSG-${uid}`;
  await saveMessage({messageId,requestId:`REQ-${uid}`,messageType:CANCELLATION_NOTICE_TYPE,integrationNamespace:CANCELLATION_NAMESPACE,
    policyId:'HO-1',noticeId:'NPC-1',noticeSnapshotId:'SNAP-1',providerMessageId,
    deliveryMode:'REAL_PROVIDER',emailDeliveryStatus:'DELIVERY_PENDING',providerDelivery:{provider:'RESEND'},
    attachments:[],formsDelivery:{status:'NOT_REQUESTED'},createdAt:new Date().toISOString()});
  const event={type:'email.delivered',data:{email_id:providerMessageId}};
  const bad=await applyProviderDeliveryEvent({event,providerEventId:`bad-time-${uid}`,signatureVerified:true});
  assert.equal(bad.reason,'PROVIDER_EVENT_TIMESTAMP_INVALID');
  assert.equal(outboundWebhookHttpStatus(bad),400);
  assert.equal(cancellationDeliveryStatus(await getMessage(messageId)).deliveryEvidenceVerified,false);
  const good=await applyProviderDeliveryEvent({event:{...event,created_at:'2026-10-29T12:01:00Z'},providerEventId:`good-time-${uid}`,signatureVerified:true});
  assert.equal(outboundWebhookHttpStatus(good),200);
  assert.equal(cancellationDeliveryStatus(await getMessage(messageId)).deliveryEvidenceVerified,true);
});

test('Mock retains failed attempt and attachments for audited controlled retry',async()=>{
  const send=await readFile(new URL('../app/api/cancellation-notices/route.js',import.meta.url),'utf8');
  assert.match(send,/status: sent \? 'SENT' : 'FAILED'/);
  assert.match(send,/let messagePersisted = false/);
  assert.match(send,/if \(messagePersisted\)/);
  assert.match(send,/NOTICE_FINALIZATION_INCOMPLETE/);
  assert.match(send,/recordAudit\(sent\?'CANCELLATION_NOTICE_ACCEPTED'/);
  assert.match(send,/\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(send,/if \(sent\) await kvSet\(semanticKey[^\n]*\n\s*else await kvDelete\(semanticKey\)/);
});

test('Actual frozen PDF bytes are checked by the same resend matcher used by the API route',async()=>{
  const {original,request}=fixture();
  const bytes=await readFile(new URL('../postman/fixtures/renewal-forms-sample.pdf',import.meta.url));
  const [prepared]=await prepareUploadedAttachments([{name:'actual.pdf',type:'application/pdf',async arrayBuffer(){return bytes}}]);
  const fp=attachmentRequestFingerprint([prepared]);
  assert.deepEqual(validateControlledCancellationResend(request,{...original,attachments:fp},fp),{ok:true});
  assert.equal(validateControlledCancellationResend(request,{...original,attachments:fp},[{...fp[0],checksumSha256:'f'.repeat(64)}]).error,'RESEND_ATTACHMENT_MISMATCH');
});

test('API POST and webhook handlers actively invoke the new provider safeguards',async()=>{
  const send=await readFile(new URL('../app/api/cancellation-notices/route.js',import.meta.url),'utf8');
  const webhook=await readFile(new URL('../app/api/webhooks/resend/route.js',import.meta.url),'utf8');
  assert.match(send,/validateControlledCancellationResend\(payload, original, attachmentRequestFingerprint\(attachments\)\)/);
  assert.match(send,/prior\.resendReason !== payload\.resendReason/);
  assert.match(webhook,/outboundWebhookHttpStatus\(result\)/);
  assert.doesNotMatch(webhook,/resolved === false \? 202/);
});
