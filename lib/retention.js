// lib/retention.js — explicit retention policy + cleanup helpers.

import { retentionDays, retentionTtlSeconds } from "./environment.js";
import { deleteNamespace, kvDelete, kvGet, listRange, listReplace } from "./store.js";
import { arEmailKey, AUTO_RENEWAL_EMAIL_KEYSPACE } from "./keyspace.js";
import { recordAudit } from "./audit.js";
import { compactOfferFamilyIndexes } from "./offers.js";

export function retentionPolicy() {
  return { days: retentionDays(), ttlSeconds: retentionTtlSeconds() };
}

export function retentionExpiry(from = new Date()) {
  return new Date(from.getTime() + retentionTtlSeconds() * 1000).toISOString();
}

export function ttlSecondsUntil(expiresAt) {
  const ms = new Date(expiresAt || 0).getTime() - Date.now();
  return Math.max(1, Math.ceil((Number.isFinite(ms) ? ms : retentionTtlSeconds() * 1000) / 1000));
}

export function isExpiredTimestamp(value, now = Date.now()) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) && t <= now;
}

export async function purgeExpiredRecords() {
  const indexKey = arEmailKey("messages", "index");
  const ids = await listRange(indexKey, 0, 4999);
  const kept = [];
  let purgedMessages = 0;
  let purgedAttachments = 0;
  const now = Date.now();
  for (const id of ids) {
    const message = await kvGet(arEmailKey("message", id));
    if (!message) continue;
    if (!isExpiredTimestamp(message.retentionExpiresAt, now)) { kept.push(id); continue; }
    for (const attachment of message.attachments || []) {
      await kvDelete(arEmailKey("attachment", attachment.attachmentId)).catch(() => {});
      purgedAttachments += 1;
    }
    await kvDelete(arEmailKey("message", id));
    if (message.providerMessageId) await kvDelete(arEmailKey("provider-message", message.providerMessageId));
    purgedMessages += 1;
  }
  await listReplace(indexKey, kept);
  const offerIndexes = await compactOfferFamilyIndexes().catch(() => ({ familiesRetained: null, familiesRemoved: null }));
  await recordAudit("RETENTION_PURGE_COMPLETED", { purgedMessages, purgedAttachments, retentionDays: retentionDays() }).catch(() => {});
  return { purgedMessages, purgedAttachments, retainedMessages: kept.length, retentionDays: retentionDays(), offerIndexes };
}

export async function purgeAllMockData() {
  const deleted = await deleteNamespace(`${AUTO_RENEWAL_EMAIL_KEYSPACE}:`);
  return { deletedKeys: deleted, scope: "ALL_MOCK_EMAIL_DATA" };
}
