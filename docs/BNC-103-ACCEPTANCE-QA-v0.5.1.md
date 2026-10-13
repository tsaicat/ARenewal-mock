# BNC-103 — Auto-Renewal Provider Evidence and Customer Reply Reconciliation

**Mock service baseline:** user-supplied `ARenewal-mock-main (1).zip` (v0.5.0).  
**Mock service patch:** v0.5.1.  
**PAS baseline compared:** v7.362.1 (no PAS source modification or PAS version bump).  
**Issue evidence:** historical trainee screenshots and notes from PAS v7.139.5 (not a current v7.362.1 reproduction).  
**Scope:** externally confirmed Renewal Notice / Forms provider-delivery evidence and inbound email-response reliability.  
**Not in scope:** modifying rating, policy state, Forms snapshots, billing, UW, issuance gates, or classifying a customer reply as proof of provider delivery.

## Investigation and evidence

- The submitted Gmail screenshot shows a Renewal Notice and the customer sending `ACCEPT` to a message-correlated `arenewal+...` address. This proves the Gmail sender submitted a reply, **not** that the Mock service received the reply webhook, that the reply was classified, or that an outbound `email.delivered` provider event was recorded.
- The submitted PAS screenshot separately shows `Notice Provider Delivery: Not Sent / Pending`, `Provider Confirmation: Not Confirmed`, Forms `Not Requested`, and issue-readiness blockers. That is consistent with absent or lost **delivery** evidence; it is not automatically a failure to parse `ACCEPT`.
- PAS v7.362.1 already uses a same-origin secure gateway to read `GET /api/messages/{messageId}` and `GET /api/auto-renewal/offers/{baseOfferNumber}/responses` through `collectAutoRenewalExternalEvidence` and persists delivery, offer-family response, and acknowledgment history with distinct statuses. A historical v7.139.5 reproduction does not prove that this later PAS integration is still defective.
- **Confirmed source defect in Mock v0.5.0:** `applyProviderDeliveryEvent` rejects an event only when its provider timestamp is strictly earlier than the stored event. A later-arriving `email.sent`/`email.delivery_delayed` event with the **same or later timestamp** can overwrite `DELIVERED` with `DELIVERY_PENDING`/`DELIVERY_DELAYED`. It can also erase a prior delay with a later `email.sent`. This is a defensible mechanism for the observed "sync remains pending" symptom, but archived screenshots do not establish that it happened in the trainee's exact environment.
- **Confirmed inbound resilience defect in Mock v0.5.0:** if the signed `email.received` webhook arrives but the Resend Receiving API body fetch fails, the route still calls `processReply` with empty text. This can persist an `AMBIGUOUS` event and consume its reply-ID deduplication key, preventing the original ACCEPT content from being reprocessed on replay. This is separate from outbound-delivery confirmation.

## Implemented Mock v0.5.1 corrections

1. **Monotonic provider evidence:** ignore and audit non-final `email.sent`/`email.delivery_delayed` received after final `DELIVERED`, `BOUNCED`, or `FAILED` status, regardless of tied or later provider timestamp; preserve original final event ID/time, Form attachment state, and message/offer correlation. Ignore an out-of-order `email.sent` after `DELIVERY_DELAYED`. Legitimate newer **terminal** status evidence is not blanket-suppressed.
2. **Safe inbound retry:** a failed or empty Resend Receiving API body fetch for `email.received` now returns structured HTTP 503, with an audit record. It does **not** persist an empty-text ambiguous customer decision or consume its response deduplication key, allowing the provider to retry according to its configured webhook delivery policy.
3. **Versioned diagnostics:** Mock health, capabilities, QA page, `package.json`, and the package-lock root metadata identify version 0.5.1. All security/authentication, send, Forms package, reply classification, acknowledgement, and retention contracts remain unchanged.
4. **Regression tests:** added equal-timestamp and later-arriving non-final provider callback tests for full Forms attachment state; delayed-to-pending regression test; existing earlier-timestamp test retained.

## Validation performed (source/runtime only)

| Check | Outcome |
|---|---|
| Native Node test suite `node --test --test-concurrency=1 test/*.test.mjs` | **PASS — 37/37**, zero failures |
| Targeted delivery/runtime tests | **PASS — 8/8** |
| Native syntax checks for modified API/webhook/tests | **PASS** |
| ZIP source inventory, no secrets, no generated local DB | **PASS** |
| npm install / npm test / Vite / Next production build | **NOT RUN** as requested; user/deployment environment required |
| Live Resend signed webhook, inbound Gmail reply, DNS, Upstash, external provider/Forms delivery, PAS browser integration | **NOT VERIFIED**; requires deployed environment and fresh acceptance run |

## Deployment prerequisites and evidence-based diagnostic checklist

1. Deploy **Mock v0.5.1** first and verify `GET /api/health` and `GET /api/capabilities` identify 0.5.1. Production health should not report missing provider, signed-webhook verification, persistent storage, or service authentication configuration. These endpoints intentionally do not reveal secrets.
2. Verify the Resend webhook points to the **currently deployed** Mock host's `POST /api/webhooks/resend`, uses the matching `RESEND_WEBHOOK_SECRET`, and subscribes to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, **and `email.received`**. Validate actual accepted delivery logs in the Resend dashboard; do not assume configuration from source.
3. Verify `RESEND_SENDER` and `RESEND_REPLY_DOMAIN` correspond to sender/receiving domains configured and verified in Resend with the required inbound DNS/MX records. The screenshots show a reply to `arenewal+...@iapasapp.com`; the example `.env` proposes `reply.iapasapp.com`. Check the **deployed** reply-to domain, not only `.env.example`.
4. Confirm deployed Upstash data persistence, retention, and `ALLOWED_ORIGINS` / PAS gateway service authentication. The default Mock retention is 30 days; historical test evidence may legitimately be gone.
5. For a **fresh** notice, capture the Mock `messageId`, `threadId`, and provider message ID. In an authorized QA Inbox/service read of `GET /api/messages/{messageId}`, distinguish `emailDeliveryStatus`, `providerDelivery.providerEventType`, `providerEventId`, `providerEventReceivedAt`, and `replies`.
6. After delivery, a signed `email.delivered` should make the message `DELIVERED` with provider event ID/time and no simulation flag. If still pending, compare Resend webhook logs with Mock audit entries such as `EMAIL_DELIVERED`, `PROVIDER_EVENT_MESSAGE_NOT_FOUND`, `PROVIDER_EVENT_REGRESSION_IGNORED`, or `WEBHOOK_SIGNATURE_INVALID`; clicking PAS Sync cannot create missing provider evidence.
7. Reply `ACCEPT` to the actual Reply-To address **before** the current offer expiry. Verify signed `email.received` plus canonical response `eventId`, classification, `normalizedDecision=ACCEPTED`, and `responseApplicability=CURRENT` in Mock `GET /api/auto-renewal/offers/{baseOfferNumber}/responses`. If absent, inspect inbound DNS/Resend receiving and `WEBHOOK_RECEIVING_API_FAILED` / address-correlation audit. A Gmail Sent item alone is not canonical customer-response proof.
8. In PAS **v7.362.1 or newer**, click `Sync External Evidence`. Confirm *both* notice provider-delivery and customer response independently. Do not use `Training Override — Mark Accepted` as proof of inbound delivery. Test against the original non-destructive issued policy; do not reset user data or mutate frozen forms/snapshots.
9. Deliver the same **frozen** Renewal Forms PDF, confirm `email.delivered` plus `messageId`, `threadId`, attachment IDs/count and package/snapshot ID. Only then confirm Issue Readiness and Process Auto-Renewal using the existing approved workflow.
10. Repeat PA and HO, success and failure cases, duplicate webhook replay, provider out-of-order events, browser refresh, partial errors, and role permissions. Verify no extra sends, no bypassed readiness, and immutable historical Forms provenance.

## Known limitations and release decision

- **Historical deliveries already downgraded in persistence are not automatically reconstructed.** The patch prevents future non-final events from erasing final evidence. Recover old records only from authentic retained provider audit/correlation through an independently approved repair procedure; do not fabricate a delivery event or toggle readiness.
- A provider webhook that was never configured, never received, failed signature verification, failed authorization, or whose underlying message is no longer retained is not recoverable by changing frontend sync code alone.
- A legitimately late, superseded, ambiguous, or obsolete-package reply must remain non-actionable under current PAS business rules. ACCEPT is not unconditional readiness.
- **BNC-103 disposition:** Mock source-level defects corrected, but **end-to-end browser acceptance remains OPEN** until a fresh current-baseline PAS + deployed Mock v0.5.1 run confirms delivery, reply, Forms, and issuance. The v7.139.5 screenshots are historical reproduction evidence only.

**Proposed Mock API commit:** `App v0.5.1 - Preserve provider delivery evidence and retry inbound renewal replies`  
**PAS version:** stays `7.362.1` — no PAS code changes; no PAS release ZIP required for this scoped Mock patch.
