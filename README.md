# Mock Renewal Email API

A standalone, Vercel-hosted Next.js app that stands in for the email leg of
PAS Auto-Renewal (BRD-005) until PAS has a real server-side gateway. Same
pattern as `mock-pas-api.vercel.app`.

It sends renewal offer/notice emails via Resend, receives and classifies
customer replies (ACCEPT / DECLINE / AMBIGUOUS), and simulates the PAS-side
callback so the full loop can be tested locally before PAS exposes a real
inbound API.

```
PAS browser
   |  POST /api/renewal-emails
   v
Mock Email API  <-- this app
   |  sends via Resend, stores message
   |  classifies inbound replies (webhook or simulated)
   v
POST /api/auto-renewal/email-responses
   (mock PAS gateway target, for now — see "Not in scope" below)
```

## Scope (v0.3)

| # | Feature | Where |
|---|---|---|
| 1 | `POST /api/renewal-emails` — send + store | `app/api/renewal-emails/route.js` |
| 2 | 60/45/15-day notice templates, auto-selected | `lib/templates.js` |
| 3 | `POST /api/webhooks/resend` — real inbound reply webhook | `app/api/webhooks/resend/route.js` |
| 4 | Deterministic ACCEPT/DECLINE/AMBIGUOUS classifier | `lib/classifier.js` |
| 5 | `POST /api/auto-renewal/email-responses` — mock PAS callback target | `app/api/auto-renewal/email-responses/route.js` |
| 6 | Inbox/message viewer UI | `app/page.jsx` |
| 7 | Idempotency on `eventId` / `replyId` / `requestId` | `lib/store.js` (`kvSetIfAbsent`), used throughout |
| 8 | Audit log | `lib/audit.js`, `GET /api/audit` |
| 9 | Postman collection | `postman/Mock-Renewal-Email-API.postman_collection.json` |
| 10 | Privacy field stripping | `lib/privacy.js` |
| 11 | Real Forms PDF upload + persistent attachment storage | `lib/attachments.js` |
| 12 | Forms delivery evidence separate from email delivery | `app/api/renewal-emails/route.js` |
| 13 | Attachment View/Download API + inbox UI | `app/api/messages/[messageId]/attachments/[attachmentId]/route.js`, `app/page.jsx` |
| 14 | Obsolete package response hold / revision safety | `lib/replyProcessor.js` |
| 15 | In-app API Reference | `app/page.jsx` |

**Not in scope yet**: changing PAS itself to upload the frozen FORMS-13 package or consume the new `formsDelivery` response. This v0.3 project implements the Mock API capability first. `/api/auto-renewal/email-responses` remains a simulation of a future PAS-side inbound callback target.


## v0.3 Forms attachment contract

`POST /api/renewal-emails` now supports two backward-compatible modes:

### 1. Existing email-only request

```http
Content-Type: application/json
```

The existing JSON contract remains valid and does not require an attachment.
`messageId`, `threadId`, `requestId`, and `responseToken` remain supported.

### 2. Email + generated Auto-Renewal Forms

```http
Content-Type: multipart/form-data
```

Required multipart parts:

```text
metadata     JSON string containing the normal renewal email contract
attachments one or more actual PDF file parts
```

When files are supplied, metadata must include stable package correlation:

```json
{
  "requestId": "AR-EMAIL-REQ-...",
  "offerNumber": "ARN-1001",
  "sourcePolicyId": "PA2027000001-00",
  "customerRef": "CUST-1001",
  "recipient": { "name": "QA Customer", "email": "qa@example.com" },
  "noticeMilestone": "60_DAY",
  "formsPackageId": "ARN-FORMS-ARN-1001",
  "formsPackageSnapshotId": "ARN-1001:auto-renewal-forms:...",
  "responseInstructions": { "responseToken": "AR-EMAIL-TOKEN-..." },
  "offer": { "noticeMilestone": 60, "offeredPremium": 1200 }
}
```

The service receives the actual bytes, validates that the file is a real PDF,
sanitizes the filename, calculates SHA-256, persists the Base64 content in the
same storage lifecycle as the message, and passes the content to Resend as an
email attachment. Message JSON stores only safe attachment metadata; raw Base64
is never shown in the inbox or normal message-detail API.

### Attachment limits

The deployed Vercel Function has a 4.5 MB request/response payload ceiling, so
this mock intentionally uses a smaller application limit:

```text
Allowed type: application/pdf
Maximum files: 3
Maximum size per file: 3 MB
Maximum combined attachment size: 3 MB
```

The limit applies before Base64 expansion and keeps both upload and View/Download
responses below the hosting ceiling.

### Delivery response

A successful email containing Forms returns separate email and Forms evidence:

```json
{
  "messageId": "AR-EMAIL-MSG-...",
  "threadId": "AR-EMAIL-THREAD-...",
  "requestId": "AR-EMAIL-REQ-...",
  "responseToken": "AR-EMAIL-TOKEN-...",
  "emailDeliveryStatus": "SENT",
  "outcome": "EMAIL_SENT_FORMS_DELIVERED",
  "formsDelivery": {
    "status": "DELIVERED",
    "formsPackageId": "ARN-FORMS-ARN-1001",
    "formsPackageSnapshotId": "...",
    "attachmentIds": ["AR-EMAIL-ATTACHMENT-..."],
    "attachmentCount": 1,
    "deliveredAt": "..."
  }
}
```

`formsDelivery.status = DELIVERED` is never returned merely because attachment
metadata was received. An actual validated file must be persisted and included
in a successful outbound send operation.

### Failure and validation codes

The API uses actionable codes including:

```text
ATTACHMENT_REQUIRED
ATTACHMENT_TOO_LARGE
ATTACHMENT_COUNT_EXCEEDED
UNSUPPORTED_ATTACHMENT_TYPE
PACKAGE_CORRELATION_MISSING
PACKAGE_SNAPSHOT_MISMATCH
ATTACHMENT_STORAGE_FAILED
IDEMPOTENCY_CONFLICT
REQUEST_IN_PROGRESS
VALIDATION_FAILED
```

Email failure remains represented by `status = FAILED` / `outcome = EMAIL_FAILED`.
If a Forms request fails before the email can be sent (for example invalid file
or storage failure), the API does not silently drop the file and claim Forms
were delivered.
If the email send succeeds but the service cannot fully persist the attachment
delivery evidence afterward, the response uses `EMAIL_SENT_FORMS_FAILED` with
`formsDelivery.status = FAILED`; it does not downgrade that partial failure to
Forms Delivered.

### 60 / 45 / 15 and revisions

Each message keeps its own `messageId`, `requestId`, and response token while
multiple milestones may reference the same `formsPackageId` and
`formsPackageSnapshotId`. A materially revised package uses a different snapshot
identity and its history is not overwritten.

Replies are correlated back to the exact message, offer, package ID, package
snapshot, response token, and thread. If the same offer has since moved to a
newer Forms snapshot, a reply to the older snapshot is stored and audited as
`OBSOLETE_PACKAGE_RESPONSE_HELD`; it is not applied as the current offer's
ACCEPT/DECLINE response.

### QA verification fixture

`postman/fixtures/renewal-forms-sample.pdf` is a real, non-sensitive PDF fixture.
The Postman collection includes a multipart request that uploads it and a
View/Download request for the returned attachment ID.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

Locally, with no env vars set, the app runs fully self-contained: emails are
"simulated" (logged and stored, not actually sent) and data persists to
`data/db.json`. This is enough to run the Postman collection end-to-end
without any external accounts.

### 2. Resend (real sending)

1. In the [Resend dashboard](https://resend.com/domains), add and verify
   `iapasapp.com` for **sending**.
2. Create an API key with **Full access** (not "Sending access" — the
   inbound webhook needs to call the Receiving API too) and set
   `RESEND_API_KEY`.
3. Set `RESEND_SENDER=arenewal@iapasapp.com` (default already matches).

### 3. Resend Inbound (real reply receiving)

Resend's inbound **receiving** is a separate capability from sending, with
its own domain verification. Resend **strongly recommends receiving on a
dedicated subdomain** (e.g. `reply.iapasapp.com`) rather than the root
domain, so it doesn't conflict with `iapasapp.com`'s existing MX records —
adding receiving to a domain that already has mail (Google Workspace,
Outlook, etc.) would route *all* of that domain's incoming mail through
Resend instead.

1. In Resend, go to **Emails → Receiving** and add the receiving
   domain/subdomain (e.g. `reply.iapasapp.com`).
2. Add the MX record Resend gives you, at the **lowest priority number** —
   otherwise inbound mail won't route to Resend. Wait until Resend shows it
   as verified.
3. Go to **Webhooks → Add Webhook**, point it at
   `https://<your-deployment>.vercel.app/api/webhooks/resend`, and subscribe
   to the `email.received` event only.
4. Copy the signing secret into `RESEND_WEBHOOK_SECRET`.
5. **Set `RESEND_REPLY_DOMAIN` to whatever domain you enabled receiving on**
   (e.g. `reply.iapasapp.com`). This can differ from `RESEND_SENDER`'s
   domain — that's the whole point of using a subdomain. If you skip this,
   it silently falls back to the sending domain, and replies will bounce
   because receiving was never enabled there.

Outbound renewal emails are sent with `reply_to` set to
`arenewal+{messageId}@{RESEND_REPLY_DOMAIN}`. When a customer hits "Reply,"
that plus-address round-trips through the inbound webhook, which is how this
app matches a reply back to the original message without depending on the
customer preserving email threading headers.

> Resend's `email.received` webhook payload is metadata-only (sender,
> recipient, subject) — no body. The webhook route calls Resend's Receiving
> Receiving REST API (`GET /emails/receiving/{email_id}`) to fetch the actual reply text before
> classifying it. This is the call that needs a Full-access API key.

**Confirm the setup before wiring DNS**, in this order:

1. Use `POST /api/renewal-emails/{messageId}/replies` (or the "Simulate a
   reply" box in the inbox UI) with `ACCEPT` as the body. If the register
   updates to `Accepted`, storage, classification, and the callback loop are
   all working — only the *real inbound webhook path* is untested.
2. Once DNS/MX propagates and Resend shows the receiving domain as
   verified, send a real offer email and reply to it from Gmail. Check
   **Resend → Webhooks → \[your webhook] → Recent deliveries** to confirm
   `email.received` actually fired; if it didn't, the MX record is the
   first thing to recheck.

If you'd rather not wait on real inbound email while testing, use
`POST /api/renewal-emails/{messageId}/replies` (see Postman collection) —
it runs through the exact same classify → store → callback pipeline.

### 4. Persistence (Upstash Redis)

Vercel serverless functions don't share memory or local disk across
invocations, so production needs an external key-value store:

1. Create a free database at [upstash.com](https://upstash.com) (Redis,
   REST API), or add the "Vercel KV" marketplace integration (same thing
   under the hood, same env var names).
2. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into your
   Vercel project's environment variables.

Without these set, the app falls back to `data/db.json` — fine for local
dev, but each Vercel deployment/invocation would otherwise see empty data.

### 5. Deploy

```bash
vercel deploy
```

Set the four env vars above (`RESEND_API_KEY`, `RESEND_SENDER`,
`RESEND_WEBHOOK_SECRET`, `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`) in the Vercel project settings, then re-deploy
or redeploy the webhook once the URL is known (chicken-and-egg with the
webhook secret — deploy once, register the webhook, add the secret,
redeploy).

## Idempotency

| Key | Guards against |
|---|---|
| `requestId` | Re-sending the same outbound offer email request |
| `replyId` | A duplicated/retried inbound reply (webhook redelivery or a repeated simulate-reply call) |
| `eventId` | A duplicated callback POST to the PAS-side target |

All three use `kvSetIfAbsent` (`SET ... NX` on Redis) so the check-and-set is
atomic — no separate "check, then write" race.

## Privacy

Per `auto-renewal-email-contract-starter.json`'s `privacyExclusions`, the
following are stripped recursively (any depth, any nesting) from every
inbound request **before** it is stored, emailed, or forwarded to a
callback: `ssn`, `ssnLast4`, `dateOfBirth`, `paymentAccount`,
`insuranceScoreRawResponse`, `occupancyInsightRawResponse`. See
`lib/privacy.js`. Stripped field *names* (never values) are recorded in the
audit log so you can confirm the guard fired.

## Classification rules

Deterministic keyword/phrase matching — no ML/LLM call — per the handoff
doc. A message can supply its own `responseInstructions.acceptKeywords` /
`declineKeywords`, which are unioned with a built-in default list. Replies
containing both accept and decline language, or neither, classify as
`AMBIGUOUS` and are flagged `requiresManualReview: true`. See
`lib/classifier.js`.

## Local development

```bash
npm run dev
```

Open `http://localhost:3000` for the inbox UI, or drive everything through
the Postman collection in `postman/`.

## Shared Upstash database namespace

This service may share an Upstash Redis database with the PAS report MockAPI. All keys created by this application are therefore isolated under:

```text
ar-email:v1:*
```

Examples include `ar-email:v1:message:*`, `ar-email:v1:offer:*`, `ar-email:v1:audit:log`, and `ar-email:v1:outbound-request:*`. Do not replace these with generic `message:*`, `offer:*`, `audit:*`, or `request:*` keys.

The `/api/renewal-emails` route also supports browser CORS preflight for the PAS Vite application.


## PAS outbound request ownership

For the browser PAS send flow, `requestId`, `offerNumber`, `sourcePolicyId`, `customerRef`, and `recipient.email` are required. PAS sends the detected numeric milestone in `offer.noticeMilestone` (`60`, `45`, or `15`). PAS may render a local read-only preview, but it omits the final `subject` and `body`; this API selects and renders the authoritative server-side template before sending through Resend.
