// lib/offers.js
//
// Tracks the mock app's own view of each offer's customer-response state
// (mirrors the `emailGateway` + `customerResponseHistory` shape the
// handoff doc says PAS will eventually need). This is NOT the system of
// record — PAS is — this only reflects what the email gateway has
// observed and reported.

import { kvGet, kvSet, listPush, listRange } from "./store";

const OFFER_KEY = (offerNumber) => `offer:${offerNumber}`;
const OFFER_HISTORY_KEY = (offerNumber) => `offer:${offerNumber}:history`;

export async function getOfferState(offerNumber) {
  return (
    (await kvGet(OFFER_KEY(offerNumber))) || {
      offerNumber,
      emailGateway: {
        messageId: "",
        threadId: "",
        deliveryStatus: "",
        deliveryAcceptedAt: "",
        deliveredAt: "",
        lastReplyId: "",
        lastReplyReceivedAt: "",
        lastClassification: "",
        classificationConfidence: null,
        matchedPhrase: "",
        requiresManualReview: false,
        callbackEventId: "",
        callbackStatus: "",
        callbackAttempts: 0,
        lastCallbackAt: "",
      },
    }
  );
}

export async function setOfferState(offerNumber, patch) {
  const current = await getOfferState(offerNumber);
  const updated = {
    ...current,
    ...patch,
    emailGateway: { ...current.emailGateway, ...(patch.emailGateway || {}) },
  };
  await kvSet(OFFER_KEY(offerNumber), updated);
  return updated;
}

export async function appendOfferHistory(offerNumber, row) {
  await listPush(OFFER_HISTORY_KEY(offerNumber), row, 200);
}

export async function getOfferHistory(offerNumber, limit = 50) {
  return listRange(OFFER_HISTORY_KEY(offerNumber), 0, limit - 1);
}
