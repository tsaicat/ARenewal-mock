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
import { stripQuotedReplyText } from "./emailQuote";
import { getOfferState, setOfferState, appendOfferHistory } from "./offers";
import { postCallback } from "./callback";
import { recordAudit } from "./audit";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "./privacy";
import { newId } from "./ids";
import { arEmailKey } from "./keyspace";

const REPLY_KEY = (replyId) => arEmailKey("reply", replyId);

export async function getRepliesForMessage(messageId) {
  const { listRange } = await import("./store");
  const replyIds = await listRange(arEmailKey("message", messageId, "replies"), 0, 99);
  const replies = await Promise.all(replyIds.map((id) => kvGet(REPLY_KEY(id))));
  return replies.filter(Boolean);
}

export async function processReply({ messageId, replyId, from, subject, plainText, receivedAt, rawSource, requestUrl }) {
  // --- idempotency: a repeated replyId must not create duplicate history ---
  const dedupeKey = arEmailKey("reply-seen", replyId);
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
  const classifyText = stripQuotedReplyText(plainText);
  const classification = classifyReply(classifyText, message.responseInstructions);
  const requestedPasStatus = CLASSIFICATION_TO_PAS_STATUS[classification.classification];

  const offerState = await getOfferState(message.offerNumber);
  const previousStatus = offerState.customerResponseStatus || "Pending";
  const currentSnapshotId = String(offerState.currentFormsPackageSnapshotId || "");
  const messageSnapshotId = String(message.formsPackageSnapshotId || "");
  const obsoletePackageResponse = Boolean(
    currentSnapshotId && messageSnapshotId && currentSnapshotId !== messageSnapshotId
  );
  const requiresManualReview = classification.classification === "AMBIGUOUS" || obsoletePackageResponse;
  const appliedPasStatus = obsoletePackageResponse ? previousStatus : requestedPasStatus;

  const reply = {
    replyId,
    messageId,
    threadId: message.threadId,
    offerNumber: message.offerNumber,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    responseToken: message.responseToken || message.responseInstructions?.responseToken || null,
    noticeMilestone: message.noticeMilestone || null,
    from,
    subject,
    plainText,
    classifiedText: classifyText,
    receivedAt: receivedAt || new Date().toISOString(),
    classification: classification.classification,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    requestedPasStatus,
    appliedPasStatus,
    obsoletePackageResponse,
    appliedToCurrentOffer: !obsoletePackageResponse,
    requiresManualReview,
    privacyFieldsStripped,
    rawSource: safeRawSource,
  };

  await kvSet(REPLY_KEY(replyId), reply);
  await listPush(arEmailKey("message", messageId, "replies"), replyId, 100);
  await recordAudit("REPLY_RECEIVED", {
    replyId,
    messageId,
    offerNumber: message.offerNumber,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    classification: classification.classification,
    obsoletePackageResponse,
    privacyFieldsStripped,
  });

  if (obsoletePackageResponse) {
    await recordAudit("OBSOLETE_PACKAGE_RESPONSE_HELD", {
      replyId,
      messageId,
      offerNumber: message.offerNumber,
      formsPackageSnapshotId: messageSnapshotId,
      currentFormsPackageSnapshotId: currentSnapshotId,
      requestedPasStatus,
    });
  } else {
    await setOfferState(message.offerNumber, {
      sourcePolicyId: message.sourcePolicyId,
      resultingPolicyId: message.resultingPolicyId,
      customerRef: message.customerRef,
      customerResponseStatus: requestedPasStatus,
      emailGateway: {
        messageId,
        threadId: message.threadId,
        lastReplyId: replyId,
        lastReplyReceivedAt: reply.receivedAt,
        lastClassification: classification.classification,
        classificationConfidence: classification.confidence,
        matchedPhrase: classification.matchedPhrase || "",
        requiresManualReview,
        responseFormsPackageId: message.formsPackageId || "",
        responseFormsPackageSnapshotId: message.formsPackageSnapshotId || "",
      },
    });
  }

  await appendOfferHistory(message.offerNumber, {
    eventId: null,
    replyId,
    messageId,
    offerNumber: message.offerNumber,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    previousStatus,
    newStatus: appliedPasStatus,
    requestedStatus: requestedPasStatus,
    appliedToCurrentOffer: !obsoletePackageResponse,
    obsoletePackageResponse,
    classification: classification.classification,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    receivedFrom: from,
    receivedAt: reply.receivedAt,
    appliedAt: obsoletePackageResponse ? null : new Date().toISOString(),
    source: "Mock Email API",
  });

  // Build + post a PAS callback event. Obsolete package responses are still
  // reported for audit/correlation, but are explicitly marked held so the
  // callback target cannot silently apply them as the current offer response.
  const eventId = newId("AR-EMAIL-EVENT");
  const event = {
    eventId,
    eventType: "AUTO_RENEWAL_CUSTOMER_RESPONSE",
    messageId,
    threadId: message.threadId,
    replyId,
    offerNumber: message.offerNumber,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    responseToken: message.responseToken || message.responseInstructions?.responseToken || null,
    noticeMilestone: message.noticeMilestone || null,
    sourcePolicyId: message.sourcePolicyId,
    resultingPolicyId: message.resultingPolicyId,
    customerRef: message.customerRef,
    customerResponse: {
      classification: classification.classification,
      pasStatus: requestedPasStatus,
      appliedPasStatus,
      confidence: classification.confidence,
      matchedPhrase: classification.matchedPhrase,
      receivedFrom: from,
      receivedAt: reply.receivedAt,
    },
    rawReply: { subject, plainText },
    resolution: {
      resolutionPath: "EMAIL_REPLY_CLASSIFICATION",
      requiresManualReview,
      obsoletePackageResponse,
      appliedToCurrentOffer: !obsoletePackageResponse,
      currentFormsPackageSnapshotId: currentSnapshotId || null,
    },
  };

  const callbackTarget = message.callback && message.callback.url;
  const { deduped, result } = await postCallback({ event, targetUrl: callbackTarget, requestUrl });

  await setOfferState(message.offerNumber, {
    emailGateway: {
      callbackEventId: eventId,
      callbackStatus: result?.body?.status || (result?.ok ? "APPLIED" : "FAILED"),
      callbackAttempts: (offerState.emailGateway?.callbackAttempts || 0) + 1,
      lastCallbackAt: new Date().toISOString(),
    },
  });

  return {
    duplicate: false,
    reply,
    classification,
    obsoletePackageResponse,
    appliedToCurrentOffer: !obsoletePackageResponse,
    callback: { eventId, deduped, result },
  };
}
