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

## Scope (v1)

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

**Not in scope yet** (per the handoff doc): a real PAS-side send button/modal,
and real PAS callback wiring — PAS is currently a browser-only IndexedDB app
with no server API, so `/api/auto-renewal/email-responses` here is a
*simulation* of what that endpoint will do once PAS exposes a real one.

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
   `iapasapp.com` (or a subdomain, see step 3).
2. Create an API key and set `RESEND_API_KEY`.
3. Set `RESEND_SENDER=arenewal@iapasapp.com` (default already matches).

### 3. Resend Inbound (real reply receiving)

Resend's inbound receiving is separate from sending, and Resend
**strongly recommends receiving on a subdomain** (e.g. `reply.iapasapp.com`)
rather than the root domain, to avoid conflicting with your existing MX
records:

1. In Resend, go to **Emails → Receiving** and add your domain/subdomain.
2. Add the MX record Resend gives you, at the **lowest priority number** —
   otherwise inbound mail won't route to Resend.
3. Go to **Webhooks → Add Webhook**, point it at
   `https://<your-deployment>.vercel.app/api/webhooks/resend`, and subscribe
   to the `email.received` event only.
4. Copy the signing secret into `RESEND_WEBHOOK_SECRET`.

Outbound renewal emails are sent with `reply_to` set to
`arenewal+{messageId}@iapasapp.com`. When a customer hits "Reply," that
plus-address round-trips through the inbound webhook, which is how this app
matches a reply back to the original message without depending on the
customer preserving email threading headers.

> Resend's `email.received` webhook payload is metadata-only (sender,
> recipient, subject) — no body. The webhook route calls Resend's Receiving
> API (`resend.emails.receiving.get`) to fetch the actual reply text before
> classifying it.

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
