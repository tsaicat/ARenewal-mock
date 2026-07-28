// lib/replyProcessor.js
//
// Shared pipeline used by both:
//   - POST /api/renewal-emails/{messageId}/replies (manual/simulated reply)
//   - POST /api/webhooks/resend (real inbound reply via Resend)
//
// Steps: idempotency check on replyId -> classify -> store reply ->
// update offer state -> build callback event -> post callback
// (idempotent on eventId) -> audit every step.

import { kvGet, kvSet, kvSetIfAbsent, listPush } from "./store";
import { getMessage } from "./messages";
import { classifyReply, CLASSIFICATION_TO_PAS_STATUS } from "./classifier";
import { getOfferState, setOfferState, appendOfferHistory } from "./offers";
import { postCallback } from "./callback";
import { recordAudit } from "./audit";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "./privacy";
import { newId } from "./ids";

const REPLY_KEY = (replyId) => `reply:${replyId}`;

export async function getRepliesForMessage(messageId) {
  const { listRange } = await import("./store");
  const replyIds = await listRange(`message:${messageId}:replies`, 0, 99);
  const replies = await Promise.all(replyIds.map((id) => kvGet(REPLY_KEY(id))));
  return replies.filter(Boolean);
}

export async function processReply({ messageId, replyId, from, subject, plainText, receivedAt, rawSource, requestUrl }) {
  // --- idempotency: a repeated replyId must not create duplicate history ---
  const dedupeKey = `reply-seen:${replyId}`;
  const isFirst = await kvSetIfAbsent(dedupeKey, { replyId, at: new Date().toISOString() });
  if (!isFirst) {
    const prior = await kvGet(REPLY_KEY(replyId));
    await recordAudit("REPLY_DUPLICATE_IGNORED", { replyId, messageId });
    return { duplicate: true, reply: prior };
  }

  const message = await getMessage(messageId);
  if (!message) {
    return { error: "MESSAGE_NOT_FOUND", status: 404 };
  }

  const privacyFieldsStripped = findPrivacyFieldsPresent({ from, subject, plainText, rawSource });
  const safeRawSource = stripPrivacyFields(rawSource);

  const classification = classifyReply(plainText, message.responseInstructions);
  const pasStatus = CLASSIFICATION_TO_PAS_STATUS[classification.classification];
  const requiresManualReview = classification.classification === "AMBIGUOUS";

  const reply = {
    replyId,
    messageId,
    threadId: message.threadId,
    offerNumber: message.offerNumber,
    from,
    subject,
    plainText,
    receivedAt: receivedAt || new Date().toISOString(),
    classification: classification.classification,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    privacyFieldsStripped,
    rawSource: safeRawSource,
  };

  await kvSet(REPLY_KEY(replyId), reply);
  await listPush(`message:${messageId}:replies`, replyId, 100);
  await recordAudit("REPLY_RECEIVED", {
    replyId,
    messageId,
    offerNumber: message.offerNumber,
    classification: classification.classification,
    privacyFieldsStripped,
  });

  const offerState = await getOfferState(message.offerNumber);
  const previousStatus = offerState.customerResponseStatus || "Pending";

  await setOfferState(message.offerNumber, {
    sourcePolicyId: message.sourcePolicyId,
    resultingPolicyId: message.resultingPolicyId,
    customerRef: message.customerRef,
    customerResponseStatus: pasStatus,
    emailGateway: {
      messageId,
      threadId: message.threadId,
      lastReplyId: replyId,
      lastReplyReceivedAt: reply.receivedAt,
      lastClassification: classification.classification,
      classificationConfidence: classification.confidence,
      matchedPhrase: classification.matchedPhrase || "",
      requiresManualReview,
    },
  });

  await appendOfferHistory(message.offerNumber, {
    eventId: null, // filled in below once created
    replyId,
    messageId,
    offerNumber: message.offerNumber,
    previousStatus,
    newStatus: pasStatus,
    classification: classification.classification,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    receivedFrom: from,
    receivedAt: reply.receivedAt,
    appliedAt: new Date().toISOString(),
    source: "Mock Email API",
  });

  // --- build + post the PAS callback event ---
  const eventId = newId("EMAIL-EVENT");
  const event = {
    eventId,
    eventType: "AUTO_RENEWAL_CUSTOMER_RESPONSE",
    messageId,
    threadId: message.threadId,
    replyId,
    offerNumber: message.offerNumber,
    sourcePolicyId: message.sourcePolicyId,
    resultingPolicyId: message.resultingPolicyId,
    customerRef: message.customerRef,
    customerResponse: {
      classification: classification.classification,
      pasStatus,
      confidence: classification.confidence,
      matchedPhrase: classification.matchedPhrase,
      receivedFrom: from,
      receivedAt: reply.receivedAt,
    },
    rawReply: { subject, plainText },
    resolution: {
      resolutionPath: "EMAIL_REPLY_CLASSIFICATION",
      requiresManualReview,
    },
  };

  const callbackTarget = message.callback && message.callback.url;
  const { deduped, result } = await postCallback({ event, targetUrl: callbackTarget, requestUrl });

  await setOfferState(message.offerNumber, {
    emailGateway: {
      callbackEventId: eventId,
      callbackStatus: result?.ok ? "APPLIED" : "FAILED",
      callbackAttempts: (offerState.emailGateway?.callbackAttempts || 0) + 1,
      lastCallbackAt: new Date().toISOString(),
    },
  });

  return {
    duplicate: false,
    reply,
    classification,
    callback: { eventId, deduped, result },
  };
}
