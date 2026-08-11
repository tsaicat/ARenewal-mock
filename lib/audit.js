// lib/audit.js
//
// Append-only audit trail of every message sent, reply received, and
// callback attempt made. Per handoff doc rule #10: "Store every received
// reply and callback attempt for audit."

import { listPush, listRange, listReplace } from "./store.js";
import { retentionDays } from "./environment.js";
import { arEmailKey } from "./keyspace.js";

const AUDIT_KEY = arEmailKey("audit", "log");

/**
 * @param {string} eventType
 */
export async function recordAudit(eventType, detail) {
  const entry = {
    auditId: `AR-EMAIL-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType,
    at: new Date().toISOString(),
    ...detail,
  };
  await listPush(AUDIT_KEY, entry, 1000);
  // Compact stale audit rows on server-side writes so retention does not rely on the QA UI being opened.
  const rows = await listRange(AUDIT_KEY, 0, 999);
  const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
  const retained = rows.filter((row) => {
    const t = new Date(row.at || 0).getTime();
    return !Number.isFinite(t) || t >= cutoff;
  });
  if (retained.length !== rows.length) await listReplace(AUDIT_KEY, retained);
  return entry;
}

export async function getAuditLog(limit = 200) {
  const rows = await listRange(AUDIT_KEY, 0, Math.max(limit * 3, limit - 1));
  const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
  const retained = rows.filter((row) => {
    const t = new Date(row.at || 0).getTime();
    return !Number.isFinite(t) || t >= cutoff;
  });
  if (retained.length !== rows.length) await listReplace(AUDIT_KEY, retained);
  return retained.slice(0, limit);
}
