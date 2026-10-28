import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCancellationRequest, cancellationRequestFingerprint, cancellationDeliveryStatus, CANCELLATION_NOTICE_TYPE } from '../lib/cancellationNotices.js';
import { saveMessage, getMessage } from '../lib/messages.js';
import { applyProviderDeliveryEvent } from '../lib/delivery.js';

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const makeRequest = () => ({
 requestId:'REQ-001',policyId:'HO2026999999-00',customerRef:'CUSTOMER-1',noticeId:'NPC-01',noticeSnapshotId:'NOTICE-FROZEN-1',
 recipient:{email:'academy@example.test'}, subject:'Training non-payment notice',
 body:{plainText:'This is a fictional Academy notice. Payment is overdue.'}, messageType:CANCELLATION_NOTICE_TYPE,
});

test('Cancellation notice requires explicit frozen identity, content, and package correlation for PDFs',()=>{
 const p=makeRequest();assert.deepEqual(validateCancellationRequest(p,[]),{ok:true});
 assert.equal(validateCancellationRequest({...p,noticeSnapshotId:''},[]).error,'VALIDATION_FAILED');
 assert.equal(validateCancellationRequest({...p,subject:''},[]).error,'NOTICE_CONTENT_REQUIRED');
 assert.equal(validateCancellationRequest({...p,body:{plainText:'123-45-6789'}},[]).error,'SENSITIVE_CONTENT_PROHIBITED');
 assert.equal(validateCancellationRequest(p,[{}]).error,'PACKAGE_CORRELATION_REQUIRED');
 assert.equal(validateCancellationRequest({...p,formsPackageId:'PKG',formsPackageSnapshotId:'SNAP'},[{}]).ok,true);
 assert.equal(validateCancellationRequest({...p,messageType:'AUTO_RENEWAL_OFFER'},[]).error,'MESSAGE_TYPE_MISMATCH');
 assert.equal(validateCancellationRequest({...p,resend:true},[]).error,'RESEND_PROVENANCE_REQUIRED');
});

test('Idempotency fingerprint binds notice/recipient/body/attachment values',()=>{
 const p=makeRequest(),base=cancellationRequestFingerprint(p,[]);
 assert.equal(base,cancellationRequestFingerprint({...p},[]));
 assert.notEqual(base,cancellationRequestFingerprint({...p,noticeSnapshotId:'ANOTHER'},[]));
 assert.notEqual(base,cancellationRequestFingerprint({...p,body:{plainText:'Different content'}},[]));
 assert.notEqual(base,cancellationRequestFingerprint(p,[{checksumSha256:'another'}]));
});

test('Provider accepted/simulated/unsigned delivered events cannot certify PAS notice evidence; signed delivered webhook can',async()=>{
 const id=suffix(),providerMessageId=`provider-${id}`,messageId=`NPC-${id}`;
 await saveMessage({messageId,requestId:`REQ-${id}`,messageType:CANCELLATION_NOTICE_TYPE,
   policyId:'HO-1',noticeId:'NPC-1',noticeSnapshotId:'SNAP-1',customerRef:'CUSTOMER-1',
   deliveryMode:'REAL_PROVIDER',emailDeliveryStatus:'DELIVERY_PENDING',providerMessageId,
   providerDelivery:{provider:'RESEND',providerEventId:null},attachments:[],formsDelivery:{status:'NOT_REQUESTED'},
 });
 let status=cancellationDeliveryStatus(await getMessage(messageId));assert.equal(status.notice,null);
 await applyProviderDeliveryEvent({event:{type:'email.delivered',created_at:'2026-10-28T12:00:00Z',data:{email_id:providerMessageId}},providerEventId:`unsigned-${id}`,signatureVerified:false});
 status=cancellationDeliveryStatus(await getMessage(messageId));assert.equal(status.deliveryStatus,'DELIVERED');assert.equal(status.deliveryEvidenceVerified,false);assert.equal(status.notice,null);
 await applyProviderDeliveryEvent({event:{type:'email.delivered',created_at:'2026-10-28T12:01:00Z',data:{email_id:providerMessageId}},providerEventId:`signed-${id}`,signatureVerified:true});
 status=cancellationDeliveryStatus(await getMessage(messageId));assert.equal(status.deliveryEvidenceVerified,true);
 assert.deepEqual(status.notice,{
   deliveryStatus:'DELIVERED',deliveryEventId:`signed-${id}`,externalMessageId:providerMessageId,
   provider:'RESEND',deliveredAt:'2026-10-28T12:01:00Z',evidenceSource:'EXTERNAL_PROVIDER_DELIVERY_WEBHOOK',
 });
 const repeated=await applyProviderDeliveryEvent({event:{type:'email.delivered',created_at:'2026-10-28T12:01:00Z',data:{email_id:providerMessageId}},providerEventId:`signed-${id}`,signatureVerified:true});
 assert.equal(repeated.duplicate,true);
 assert.equal(cancellationDeliveryStatus({...await getMessage(messageId),resendSimulated:true}).notice,null);
});

test('Later provider bounce invalidates previously delivered notice evidence',async()=>{
 const id=suffix(),providerMessageId=`provider-${id}`,messageId=`NPC-${id}`;
 await saveMessage({messageId,requestId:`REQ-${id}`,messageType:CANCELLATION_NOTICE_TYPE,policyId:'HO-2',noticeId:'NPC-2',noticeSnapshotId:'SNAP-2',
  deliveryMode:'REAL_PROVIDER',emailDeliveryStatus:'DELIVERY_PENDING',providerMessageId,providerDelivery:{provider:'RESEND'},attachments:[],formsDelivery:{status:'NOT_REQUESTED'}});
 const event=(type,at)=>({type,created_at:at,data:{email_id:providerMessageId}});
 await applyProviderDeliveryEvent({event:event('email.delivered','2026-10-28T12:00:00Z'),providerEventId:`signed-a-${id}`,signatureVerified:true});
 assert.ok(cancellationDeliveryStatus(await getMessage(messageId)).notice);
 await applyProviderDeliveryEvent({event:event('email.bounced','2026-10-28T12:02:00Z'),providerEventId:`signed-b-${id}`,signatureVerified:true});
 assert.equal(cancellationDeliveryStatus(await getMessage(messageId)).notice,null);
});

test('Cancellation message does not mutate renewal offer state, and reads bypass offer-family lookup',async()=>{
 const delivery=await readFile(new URL('../lib/delivery.js',import.meta.url),'utf8');
 const detail=await readFile(new URL('../app/api/messages/[messageId]/route.js',import.meta.url),'utf8');
 const reply=await readFile(new URL('../app/api/renewal-emails/[messageId]/replies/route.js',import.meta.url),'utf8');
 const send=await readFile(new URL('../app/api/cancellation-notices/route.js',import.meta.url),'utf8');
 assert.match(delivery,/message\.messageType !== "NON_PAYMENT_CANCELLATION_NOTICE"/);
 assert.match(detail,/message\.messageType === "NON_PAYMENT_CANCELLATION_NOTICE"/);
 assert.match(reply,/NOT_RENEWAL_MESSAGE/);
 assert.match(send,/securePasWrite/);
 assert.doesNotMatch(send,/setOfferState|normalizeOfferLineage/);
});
