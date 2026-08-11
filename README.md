# Mock Renewal Email API v0.4.0

Standalone Next.js/Vercel training integration for the PAS Auto-Renewal email workflow.

## v0.4.0 focus

MOCK-AR-API-06 hardens lifecycle correlation and delivery truthfulness without modifying PAS:

- provider send acceptance is no longer final delivery;
- Resend delivery/bounce/failure webhooks update stored evidence asynchronously;
- Forms delivery remains separate from email delivery;
- production/provider-missing requests cannot silently become delivered; explicit local simulation is labeled `SIMULATED`;
- explicit offer-family/version/supersession lineage is supported while old clients remain compatible;
- every customer response has a stable canonical `eventId`;
- response intent is separate from applicability (`CURRENT`, `LATE`, `SUPERSEDED_OFFER`, `OBSOLETE_PACKAGE`, `MANUAL_REVIEW_REQUIRED`);
- ambiguous/negated classifier language is held for manual review;
- normal 60/45/15 sends are semantically idempotent in addition to request-ID idempotency;
- controlled resend is explicit and audited;
- Acceptance/Decline acknowledgment delivery is supported;
- consolidated offer-family response history is available.

See `docs/MOCK_AR_API_06_CONTRACT.md` for the exact contract.

## Core endpoints

```text
POST /api/renewal-emails
GET  /api/renewal-emails
GET  /api/messages/{messageId}
POST /api/renewal-emails/{messageId}/replies
POST /api/messages/{messageId}/acknowledgments
GET  /api/auto-renewal/offers/{baseOfferNumber}/responses
POST /api/webhooks/resend
GET  /api/audit
```

## Delivery lifecycle

Real provider-backed send:

```text
POST accepted
→ Email DELIVERY_PENDING
→ Forms DELIVERY_PENDING
→ Resend webhook
   email.delivered        → Email DELIVERED / Forms DELIVERED
   email.delivery_delayed → Email DELIVERY_DELAYED / Forms DELIVERY_PENDING
   email.bounced          → Email BOUNCED / Forms FAILED
   email.failed           → Email FAILED / Forms FAILED
```

Resend documents `email.sent` as successful API submission/attempted delivery and `email.delivered` as successful delivery to the recipient mail server. The mock follows that distinction.

## Local development

```bash
npm install
cp .env.example .env.local
```

For explicit local email simulation set:

```text
ALLOW_SIMULATED_EMAIL=true
```

Without `RESEND_API_KEY` and without this flag, outbound sending fails with provider-not-configured evidence instead of pretending external delivery occurred.

For real sending/receiving configure `RESEND_API_KEY`, `RESEND_SENDER`, `RESEND_REPLY_DOMAIN`, and `RESEND_WEBHOOK_SECRET`. Subscribe the Resend webhook to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, and `email.received`.

Use Upstash via `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for persistent deployment storage. Local development falls back to `data/db.json`.

## Attachments

Actual PDF bytes are validated, stored, sent, and retained with package/message correlation. Limits remain 3 PDFs / 3 MB per file / 3 MB total.

## PAS follow-up

PAS v7.137.13 remains a compatible older consumer, but a later PAS patch is required to consume asynchronous delivery states, offer lineage, response event IDs/history, and acknowledgment delivery. Do not interpret v0.4's new `DELIVERY_PENDING` state as the old immediate `DELIVERED` behavior.
