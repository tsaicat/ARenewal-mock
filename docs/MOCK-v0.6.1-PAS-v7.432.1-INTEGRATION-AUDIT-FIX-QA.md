# Mock Email API v0.6.1 — PAS integration audit corrections and QA

**Date:** 2026-10-29  
**Source of truth:** `ARenewal-mock-main-v0.6.0-NONPAYMENT-CANCELLATION-NOTICES.zip`  
**Target PAS contract:** PAS v7.432.1. **Scope: Mock API only.**  
**Release:** v0.6.0 → **v0.6.1** (patch-level integration/defect correction).

## Corrections included

| Issue | Correction | Behavior / safety consequence |
|---|---|---|
| Mock accepted direct resend after a delivered or still-pending notice | Service-side `validateControlledCancellationResend` permits only `FAILED` / `BOUNCED` records, with independent resend request identity | PAS UI cannot be bypassed to resend a valid delivered notice |
| Resend only compared notice IDs, recipient email and PDF | Also compares original customer reference, namespace, recipient name, subject, *verbatim* plain text, Forms package identity, and attachment file/size/SHA-256 | A frozen notice cannot be replaced by another text with the same identifiers |
| A changed resend actor/reason could replay the same `requestId` and get a duplicate success | Persisted resend provenance is checked for idempotent duplicate returns; v0.6.0 request fingerprint remains backward compatible | No migration or re-keying of existing request fingerprints |
| A recorded failed initial send released the snapshot semantic guard | Failed sends now retain their original snapshot index and message identity; further attempts must be controlled resends | Cannot skip audit history by issuing another 'first send' with a new requestId |
| Error after storing an outbound notice could delete its attachments during cleanup | Durable message boundary preserves the attachment and idempotency identity; audit/old-message-counter writes are best-effort; uncertain finalization is reported | Never falsely roll back a message that may already have been sent |
| Signed provider webhook raced the message save and received HTTP 202 | Unknown-message callback now returns **503** so the provider can retry, and the event-seen marker is released | Provider delivery evidence no longer lost by premature HTTP acknowledgment |
| Concurrent/replayed callback had no completed result yet | Distinct 120-second in-progress lease and retained completion-result identity; HTTP 503 until committed | Avoids acknowledging an incomplete callback |
| Cancellation delivery timestamp missing or malformed | Cancellation events require an explicit ISO-8601 timezone-aware provider event time; invalid input is not certified | QA simulated time cannot be mistaken for provider delivery time |
| Capabilities advertised support without distinguishing configuration | Added **optional** `cancellationDeliveryPrerequisitesConfigured` to health/capabilities; no prior fields removed | Deployment operators can see missing *configuration* without secrets or claiming a successful live delivery |

## Backward compatibility

- Existing `POST /api/cancellation-notices` and `GET /api/cancellation-notices/{messageId}` URLs and successful JSON response fields stay the same.
- The PAS v7.432.1 controlled resend contains `resend:true`, a fresh requestId, `originalMessageId`, `resendActor`, and `resendReason`, matching the new server validation. Both HO and PA PDF payloads were locally cross-validated.
- Existing v0.6.0 **requestId** fingerprints are unchanged. A duplicate resend with different provenance is now rejected with `409 IDEMPOTENCY_CONFLICT`.
- Renewal offer, email, Forms, customer reply, acknowledgment, and QA Inbox semantics were not intentionally changed.
- Historic Cancellation messages and attachments have not been rewritten or migrated.
- Server-side semantic locks for failed original notices are forward-only; pre-v0.6.1 failed attempts may not have a lock (legacy storage). The preserved message remains available by messageId while retained.

## Executed tests

- `npm test`: **53/53 PASS** (42 existing + 11 new focused tests). New tests cover frozen-content resend, failed/bounced-only restriction, altered PDFs/subject/recipient, provider-message race/retry, invalid signed callback timestamps, and service wiring.
- Standalone cross-repository PAS **v7.432.1** generated HO/PA notice + actual deterministic PDF → Mock **v0.6.1** validator + controlled resend → PAS signed evidence validator: **2/2 PASS**. No real email sent.
- `node --check`: changed JavaScript route and library files parse.
- `npm run build`: **NOT VERIFIED** — `next: not found` (Next.js dependencies not installed in this runner). Browser/live Resend UAT **NOT EXECUTED**.

## Deployment acceptance checklist (QA)

1. Keep the same Mock API service URL and `MOCK_API_KEY` (PAS proxy's `MOCK_API_KEY` must match). Do not put the key in a `VITE_` variable.
2. Confirm `RESEND_API_KEY`, sender domain, `RESEND_WEBHOOK_SECRET`, Upstash connection, Mock QA credentials, and PAS server Underwriter access grant are configured. `/api/health` must report no unresolved production `problems`; `cancellationDeliveryPrerequisitesConfigured` must be `true` for production-equivalent delivery evidence.
3. Verify `/api/capabilities` reports `serviceVersion=0.6.1`, Cancellation notice support, controlled resend, signed delivery evidence support, and the new optional configuration flag.
4. From PAS v7.432.1, on a synthetic eligible HO policy, prepare/send one approved frozen PDF. Check the Mock status returns pending and `deliveryEvidenceVerified:false` until a **real signed** Resend `email.delivered` webhook is recorded.
5. Exercise a failed/bounced **separate** QA notice, controlled resend and new messageId; verify original message remains in history and the PDF checksum is unchanged. Try an altered resend (subject or PDF) through an authenticated QA API client; expect a `409` rejection without a send.
6. Repeat with PA/AUTO. Confirm PAS cannot schedule based on unsigned, simulated, failed, or pending delivery. Check unrelated Renewal offers and messages still work.
7. Verify replay/delayed callback behavior and retained real provider timestamps in both apps before claiming end-to-end integration certification.

## Limits / explicitly NOT corrected here

- The Mock service authenticates the **PAS server** via `MOCK_API_KEY`. It cannot independently prove that the PAS browser's actor is an Underwriter or that local IndexedDB contains an eligible Policy/Billing state. PAS v7.432.1 enforces a separate server-side Underwriter access grant; full identity / record authority would require a trusted shared backend. Do **not** claim complete production RBAC.
- PAS receiving HTTP `502` for a failed first-send provider attempt may not persist the returned `messageId` into local Policy evidence. Mock preserves it and returns it in the failure response, but **PAS-side recovery UX** for this specific failure still needs a populated-browser check. This release does not modify PAS.
- There is no distributed transactional outbox between Resend delivery and the Mock database. An upstream email accepted before a total storage failure cannot be guaranteed atomic; this release improves retained-message recovery but does not claim exactly-once physical delivery.
- New Signed Provider webhook logic cannot be certified without a real deployed webhook and access to Resend/Vercel logs. A retryable `503` asks the provider to retry; it does not prove delivery.
- The Mock provider clock remains real; PAS policy-specific QA time never changes provider timestamps. Archive/retention remains according to `MOCK_DATA_RETENTION_DAYS`.

**Proposed commit message:** `App v0.6.1 - Harden Cancellation notice resend and delivery webhook recovery`
