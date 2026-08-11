// lib/callback.js
//
// Posts the AUTO_RENEWAL_CUSTOMER_RESPONSE callback event described in
// the handoff doc's "Endpoint 3 — Mock Email API callback to PAS".
//
// Since the real PAS has no server-side inbound API yet (see handoff
// doc "Critical architecture gap"), the default target is this app's
// own mock callback route (/api/auto-renewal/email-responses) so the
// full flow can be exercised locally end-to-end. A message can still
// specify a real `callback.url` once PAS exposes one.

import { kvGet, kvSet, kvSetIfAbsent } from "./store.js";
import { recordAudit } from "./audit.js";
import { arEmailKey } from "./keyspace.js";

function defaultCallbackUrl(requestUrl) {
  const origin = new URL(requestUrl).origin;
  return `${origin}/api/auto-renewal/email-responses`;
}

/**
 * Idempotent on eventId: if this eventId was already sent, we return the
 * previously recorded outcome instead of posting again.
 */
export async function postCallback({ event, targetUrl, requestUrl }) {
  const dedupeKey = arEmailKey("callback-sent", event.eventId);
  const isFirstAttempt = await kvSetIfAbsent(dedupeKey, {
    eventId: event.eventId,
    at: new Date().toISOString(),
  });

  if (!isFirstAttempt) {
    const prior = await kvGet(arEmailKey("callback-result", event.eventId));
    await recordAudit("CALLBACK_DUPLICATE_IGNORED", {
      eventId: event.eventId,
      offerNumber: event.offerNumber,
    });
    return { deduped: true, result: prior };
  }

  const url = targetUrl || defaultCallbackUrl(requestUrl);

  await recordAudit("CALLBACK_ATTEMPT", {
    eventId: event.eventId,
    offerNumber: event.offerNumber,
    targetUrl: url,
  });

  let result;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const body = await res.json().catch(() => ({}));
    result = { ok: res.ok, status: res.status, body };
  } catch (err) {
    result = { ok: false, status: 0, body: { error: String(err) } };
  }

  await kvSet_result(event.eventId, result);
  await recordAudit(result.ok ? "CALLBACK_APPLIED" : "CALLBACK_ATTEMPT", {
    eventId: event.eventId,
    offerNumber: event.offerNumber,
    ok: result.ok,
    status: result.status,
  });

  return { deduped: false, result };
}

async function kvSet_result(eventId, result) {
  await kvSet(arEmailKey("callback-result", eventId), result);
}
