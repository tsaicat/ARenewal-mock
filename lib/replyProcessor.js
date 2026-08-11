// lib/replyProcessor.js — canonical, idempotent customer-response pipeline.

import { kvGet, kvSet, kvSetIfAbsent, listPush } from "./store.js";
import { getMessage } from "./messages.js";
import {
  classifyReply,
  CLASSIFICATION_TO_PAS_STATUS,
  CLASSIFICATION_TO_NORMALIZED_DECISION,
} from "./classifier.js";
import { stripQuotedReplyText } from "./emailQuote.js";
import {
  getOfferState,
  setOfferState,
  appendOfferHistory,
  expireOfferIfNeeded,
} from "./offers.js";
import { saveResponseEvent } from "./responses.js";
import { postCallback } from "./callback.js";
import { recordAudit } from "./audit.js";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "./privacy.js";
import { newId } from "./ids.js";
import { arEmailKey } from "./keyspace.js";
import { retentionTtlSeconds } from "./environment.js";

const REPLY_KEY = (replyId) => arEmailKey("reply", replyId);

export async function getRepliesForMessage(messageId) {
  const { listRange } = await import("./store.js");
  const replyIds = await listRange(arEmailKey("message", messageId, "replies"), 0, 199);
  const replies = await Promise.all(replyIds.map((id) => kvGet(REPLY_KEY(id))));
  return replies.filter(Boolean);
}

function isAfter(value, threshold) {
  if (!value || !threshold) return false;
  const a = new Date(value).getTime();
  const b = new Date(threshold).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

export async function processReply({ messageId, replyId, from, subject, plainText, receivedAt, rawSource, requestUrl }) {
  const dedupeKey = arEmailKey("reply-seen", replyId);
  const isFirst = await kvSetIfAbsent(dedupeKey, { replyId, at: new Date().toISOString() }, { ttlSeconds: retentionTtlSeconds() });
  if (!isFirst) {
    const prior = await kvGet(REPLY_KEY(replyId));
    await recordAudit("REPLY_DUPLICATE_IGNORED", { replyId, eventId: prior?.eventId || null, messageId });
    return { duplicate: true, reply: prior };
  }

  const message = await getMessage(messageId);
  if (!message) return { error: "MESSAGE_NOT_FOUND", status: 404 };

  const authoritativeReceivedAt = receivedAt || new Date().toISOString();
  let offerState = await expireOfferIfNeeded(message.offerNumber, new Date(authoritativeReceivedAt));
  const previousStatus = offerState.customerResponseStatus || "Pending";
  const currentSnapshotId = String(offerState.currentFormsPackageSnapshotId || "");
  const messageSnapshotId = String(message.formsPackageSnapshotId || "");
  const obsoletePackageResponse = Boolean(currentSnapshotId && messageSnapshotId && currentSnapshotId !== messageSnapshotId);
  const supersededOfferResponse = offerState.offerStatus === "SUPERSEDED";
  const lateResponse = offerState.offerStatus === "EXPIRED" || isAfter(authoritativeReceivedAt, offerState.offerExpirationDate || message.offerExpirationDate);

  const privacyFieldsStripped = findPrivacyFieldsPresent({ from, subject, plainText, rawSource });
  const safeRawSource = stripPrivacyFields(rawSource);
  const classifyText = stripQuotedReplyText(plainText);
  const classification = classifyReply(classifyText, message.responseInstructions);
  const requestedPasStatus = CLASSIFICATION_TO_PAS_STATUS[classification.classification];
  const normalizedDecision = CLASSIFICATION_TO_NORMALIZED_DECISION[classification.classification];

  let responseApplicability = "CURRENT";
  if (supersededOfferResponse) responseApplicability = "SUPERSEDED_OFFER";
  else if (obsoletePackageResponse) responseApplicability = "OBSOLETE_PACKAGE";
  else if (lateResponse) responseApplicability = "LATE";
  else if (classification.classification === "AMBIGUOUS") responseApplicability = "MANUAL_REVIEW_REQUIRED";

  const actionable = responseApplicability === "CURRENT" && classification.classification !== "AMBIGUOUS";
  const requiresManualReview = !actionable;
  const appliedPasStatus = actionable ? requestedPasStatus : previousStatus;
  const eventId = newId("AR-EMAIL-EVENT");
  const processedAt = new Date().toISOString();

  const reply = {
    replyId,
    eventId,
    messageId,
    threadId: message.threadId,
    requestId: message.requestId || null,
    offerNumber: message.offerNumber,
    baseOfferNumber: message.baseOfferNumber || message.offerNumber,
    offerVersion: message.offerVersion || 1,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    responseToken: message.responseToken || message.responseInstructions?.responseToken || null,
    noticeMilestone: message.noticeMilestone || null,
    from,
    subject,
    plainText,
    classifiedText: classifyText,
    receivedAt: authoritativeReceivedAt,
    processedAt,
    callbackSentAt: null,
    classification: classification.classification,
    normalizedDecision,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    requestedPasStatus,
    appliedPasStatus,
    responseApplicability,
    obsoletePackageResponse,
    supersededOfferResponse,
    lateResponse,
    appliedToCurrentOffer: actionable,
    requiresManualReview,
    privacyFieldsStripped,
    rawSource: safeRawSource,
  };

  await kvSet(REPLY_KEY(replyId), reply, { ttlSeconds: retentionTtlSeconds() });
  await listPush(arEmailKey("message", messageId, "replies"), replyId, 200);
  await saveResponseEvent(reply);

  await recordAudit("RESPONSE_RECEIVED", {
    replyId,
    eventId,
    messageId,
    offerNumber: message.offerNumber,
    baseOfferNumber: reply.baseOfferNumber,
    offerVersion: reply.offerVersion,
    classification: classification.classification,
    normalizedDecision,
    responseApplicability,
    appliedToCurrentOffer: actionable,
    privacyFieldsStripped,
  });

  if (supersededOfferResponse) {
    await recordAudit("RESPONSE_TO_SUPERSEDED_OFFER", { eventId, replyId, messageId, offerNumber: message.offerNumber });
  } else if (lateResponse) {
    await recordAudit("LATE_RESPONSE_RECEIVED", { eventId, replyId, messageId, offerNumber: message.offerNumber, receivedAt: authoritativeReceivedAt });
  } else if (obsoletePackageResponse) {
    await recordAudit("OBSOLETE_PACKAGE_RESPONSE_HELD", {
      eventId,
      replyId,
      messageId,
      offerNumber: message.offerNumber,
      formsPackageSnapshotId: messageSnapshotId,
      currentFormsPackageSnapshotId: currentSnapshotId,
      requestedPasStatus,
    });
  }

  if (actionable) {
    offerState = await setOfferState(message.offerNumber, {
      sourcePolicyId: message.sourcePolicyId,
      resultingPolicyId: message.resultingPolicyId,
      customerRef: message.customerRef,
      customerResponseStatus: requestedPasStatus,
      emailGateway: {
        messageId,
        threadId: message.threadId,
        lastReplyId: replyId,
        lastResponseEventId: eventId,
        lastReplyReceivedAt: reply.receivedAt,
        lastClassification: classification.classification,
        classificationConfidence: classification.confidence,
        matchedPhrase: classification.matchedPhrase || "",
        requiresManualReview: false,
        responseFormsPackageId: message.formsPackageId || "",
        responseFormsPackageSnapshotId: message.formsPackageSnapshotId || "",
      },
    });
    await recordAudit("RESPONSE_APPLIED", { eventId, offerNumber: message.offerNumber, customerResponseStatus: requestedPasStatus });
  }

  await appendOfferHistory(message.offerNumber, {
    eventId,
    replyId,
    messageId,
    offerNumber: message.offerNumber,
    baseOfferNumber: reply.baseOfferNumber,
    offerVersion: reply.offerVersion,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    previousStatus,
    newStatus: appliedPasStatus,
    requestedStatus: requestedPasStatus,
    normalizedDecision,
    responseApplicability,
    appliedToCurrentOffer: actionable,
    obsoletePackageResponse,
    supersededOfferResponse,
    lateResponse,
    classification: classification.classification,
    confidence: classification.confidence,
    matchedPhrase: classification.matchedPhrase,
    receivedFrom: from,
    receivedAt: reply.receivedAt,
    appliedAt: actionable ? processedAt : null,
    source: "Mock Email API",
  });

  const event = {
    eventId,
    eventType: "AUTO_RENEWAL_CUSTOMER_RESPONSE",
    messageId,
    threadId: message.threadId,
    replyId,
    requestId: message.requestId || null,
    offerNumber: message.offerNumber,
    baseOfferNumber: reply.baseOfferNumber,
    offerVersion: reply.offerVersion,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    responseToken: reply.responseToken,
    noticeMilestone: message.noticeMilestone || null,
    sourcePolicyId: message.sourcePolicyId,
    resultingPolicyId: message.resultingPolicyId,
    customerRef: message.customerRef,
    customerResponse: {
      classification: classification.classification,
      normalizedDecision,
      pasStatus: requestedPasStatus,
      appliedPasStatus,
      confidence: classification.confidence,
      matchedPhrase: classification.matchedPhrase,
      receivedFrom: from,
      receivedAt: reply.receivedAt,
    },
    resolution: {
      responseApplicability,
      requiresManualReview,
      obsoletePackageResponse,
      supersededOfferResponse,
      lateResponse,
      appliedToCurrentOffer: actionable,
      currentFormsPackageSnapshotId: currentSnapshotId || null,
    },
  };

  const callbackTarget = message.callback && message.callback.url;
  const { deduped, result } = await postCallback({ event, targetUrl: callbackTarget, requestUrl });
  const callbackSentAt = new Date().toISOString();
  const storedReply = { ...reply, callbackSentAt };
  await kvSet(REPLY_KEY(replyId), storedReply, { ttlSeconds: retentionTtlSeconds() });
  await saveResponseEvent(storedReply);

  await setOfferState(message.offerNumber, {
    emailGateway: {
      callbackEventId: eventId,
      callbackStatus: result?.body?.status || (result?.ok ? "APPLIED" : "FAILED"),
      callbackAttempts: (offerState.emailGateway?.callbackAttempts || 0) + 1,
      lastCallbackAt: callbackSentAt,
    },
  });

  return {
    duplicate: false,
    reply: storedReply,
    classification,
    responseApplicability,
    obsoletePackageResponse,
    supersededOfferResponse,
    lateResponse,
    appliedToCurrentOffer: actionable,
    callback: { eventId, deduped, result },
  };
}
