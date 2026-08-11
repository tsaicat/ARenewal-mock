import { kvDelete, kvGet, kvSet, kvSetIfAbsent } from "./store.js";
import { arEmailKey } from "./keyspace.js";

function token(value) {
  return encodeURIComponent(String(value || "").trim().toUpperCase());
}

export function communicationSemanticKey({ baseOfferNumber, offerVersion, noticeMilestone, communicationType }) {
  if (!baseOfferNumber || !offerVersion || !noticeMilestone || !communicationType) return null;
  return arEmailKey(
    "communication",
    token(baseOfferNumber),
    token(offerVersion),
    token(noticeMilestone),
    token(communicationType)
  );
}

export async function reserveNormalCommunication(identity, requestId) {
  const key = communicationSemanticKey(identity);
  if (!key) return { reserved: true, key: null, record: null };
  const record = { ...identity, requestId, status: "PROCESSING", reservedAt: new Date().toISOString() };
  const reserved = await kvSetIfAbsent(key, record);
  return { reserved, key, record: reserved ? record : await kvGet(key) };
}

export async function completeNormalCommunication(key, patch) {
  if (!key) return;
  const current = (await kvGet(key)) || {};
  await kvSet(key, { ...current, ...patch, status: "SENT", completedAt: new Date().toISOString() });
}

export async function releaseNormalCommunication(key) {
  if (key) await kvDelete(key);
}
