// lib/audit.js
//
// Append-only audit trail of every message sent, reply received, and
// callback attempt made. Per handoff doc rule #10: "Store every received
// reply and callback attempt for audit."

import { listPush, listRange } from "./store";

const AUDIT_KEY = "audit:log";

/**
 * @param {"MESSAGE_SENT"|"REPLY_RECEIVED"|"CALLBACK_ATTEMPT"|"CALLBACK_APPLIED"|"CALLBACK_DUPLICATE_IGNORED"|"REPLY_DUPLICATE_IGNORED"} eventType
 */
export async function recordAudit(eventType, detail) {
  const entry = {
    auditId: `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
