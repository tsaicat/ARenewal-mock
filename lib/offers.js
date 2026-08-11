// lib/offers.js — offer state + explicit revision-family lineage.

import { kvGet, kvSet, listPush, listRange } from "./store.js";
import { arEmailKey } from "./keyspace.js";

const OFFER_KEY = (offerNumber) => arEmailKey("offer", offerNumber);
const OFFER_HISTORY_KEY = (offerNumber) => arEmailKey("offer", offerNumber, "history");
const OFFER_FAMILY_KEY = (baseOfferNumber) => arEmailKey("offer-family", baseOfferNumber);

export function normalizeOfferLineage(payload = {}) {
  const nested = payload.offer || {};
  const offerNumber = String(payload.offerNumber || nested.offerNumber || "").trim();
  const baseOfferNumber = String(payload.baseOfferNumber || nested.baseOfferNumber || offerNumber).trim();
  const requestedVersion = Number(payload.offerVersion ?? nested.offerVersion ?? 1);
  const offerVersion = Number.isInteger(requestedVersion) && requestedVersion > 0 ? requestedVersion : 1;
  const supersedesOfferNumber = String(payload.supersedesOfferNumber || nested.supersedesOfferNumber || "").trim() || null;
  const offerExpirationDate = payload.offerExpirationDate || nested.offerExpirationDate || nested.expiresAt || null;
  const responseDueDate = payload.responseDueDate || nested.responseDueDate || null;
  const renewalEffectiveDate = payload.renewalEffectiveDate || nested.renewalEffectiveDate || nested.effectiveDate || null;
  return {
    offerNumber,
    baseOfferNumber,
    offerVersion,
    supersedesOfferNumber,
    offerExpirationDate,
    responseDueDate,
    renewalEffectiveDate,
  };
}

export async function getOfferState(offerNumber) {
  return (
    (await kvGet(OFFER_KEY(offerNumber))) || {
      offerNumber,
      baseOfferNumber: offerNumber,
      offerVersion: 1,
      offerStatus: "CURRENT",
      supersedesOfferNumber: null,
      supersededByOfferNumber: null,
      customerResponseStatus: "Pending",
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

export async function registerOfferRevision(lineage, patch = {}) {
  const { offerNumber, baseOfferNumber, offerVersion, supersedesOfferNumber } = lineage;
  const existing = await getOfferState(offerNumber);
  const offerState = await setOfferState(offerNumber, {
    ...patch,
    offerNumber,
    baseOfferNumber,
    offerVersion,
    supersedesOfferNumber,
    offerStatus: ["COMPLETED", "EXPIRED", "SUPERSEDED"].includes(existing.offerStatus) ? existing.offerStatus : "CURRENT",
    offerExpirationDate: lineage.offerExpirationDate || existing.offerExpirationDate || null,
    responseDueDate: lineage.responseDueDate || existing.responseDueDate || null,
    renewalEffectiveDate: lineage.renewalEffectiveDate || existing.renewalEffectiveDate || null,
  });

  if (supersedesOfferNumber) {
    const prior = await getOfferState(supersedesOfferNumber);
    await setOfferState(supersedesOfferNumber, {
      baseOfferNumber,
      offerStatus: "SUPERSEDED",
      supersededAt: new Date().toISOString(),
      supersededByOfferNumber: offerNumber,
    });
  }

  const family = (await kvGet(OFFER_FAMILY_KEY(baseOfferNumber))) || {
    baseOfferNumber,
    currentOfferNumber: null,
    offerNumbers: [],
  };
  const offerNumbers = [...new Set([...(family.offerNumbers || []), ...(supersedesOfferNumber ? [supersedesOfferNumber] : []), offerNumber])];
  const shouldBecomeCurrent =
    offerState.offerStatus === "CURRENT" &&
    (family.currentOfferVersion == null || offerVersion >= Number(family.currentOfferVersion || 0));
  await kvSet(OFFER_FAMILY_KEY(baseOfferNumber), {
    ...family,
    baseOfferNumber,
    currentOfferNumber: shouldBecomeCurrent ? offerNumber : family.currentOfferNumber,
    currentOfferVersion: shouldBecomeCurrent ? offerVersion : family.currentOfferVersion,
    offerNumbers,
    updatedAt: new Date().toISOString(),
  });
  return offerState;
}

export async function getOfferFamily(baseOfferNumber) {
  return (await kvGet(OFFER_FAMILY_KEY(baseOfferNumber))) || {
    baseOfferNumber,
    currentOfferNumber: null,
    currentOfferVersion: null,
    offerNumbers: [],
  };
}

export async function getOfferFamilyStates(baseOfferNumber) {
  const family = await getOfferFamily(baseOfferNumber);
  const states = await Promise.all((family.offerNumbers || []).map((number) => getOfferState(number)));
  return { family, states };
}

export async function expireOfferIfNeeded(offerNumber, at = new Date()) {
  const state = await getOfferState(offerNumber);
  if (state.offerStatus === "SUPERSEDED" || state.offerStatus === "COMPLETED" || state.offerStatus === "EXPIRED") return state;
  const expiresAt = state.offerExpirationDate ? new Date(state.offerExpirationDate) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && at.getTime() > expiresAt.getTime()) {
    return setOfferState(offerNumber, { offerStatus: "EXPIRED", expiredAt: expiresAt.toISOString() });
  }
  return state;
}

export async function appendOfferHistory(offerNumber, row) {
  await listPush(OFFER_HISTORY_KEY(offerNumber), row, 300);
}

export async function getOfferHistory(offerNumber, limit = 100) {
  return listRange(OFFER_HISTORY_KEY(offerNumber), 0, limit - 1);
}
