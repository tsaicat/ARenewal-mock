// lib/audit.js
//
// Append-only audit trail of every message sent, reply received, and
// callback attempt made. Per handoff doc rule #10: "Store every received
// reply and callback attempt for audit."

import { listPush, listRange } from "./store.js";
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
  return entry;
}

export async function getAuditLog(limit = 200) {
  return listRange(AUDIT_KEY, 0, limit - 1);
}
