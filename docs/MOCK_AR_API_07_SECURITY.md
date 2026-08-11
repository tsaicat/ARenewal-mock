# MOCK-AR-API-07 — Security, Retention, and QA Operations Hardening

## Version

- Baseline: `v0.4.0`
- Result: `v0.5.0`
- PAS reference only: `PAS v7.137.13 — AUTO-RENEWAL-07`

## Production security model

### PAS write authentication
Production PAS-to-Mock write operations require a server-side service credential supplied as either:

- `X-Mock-Api-Key: <configured MOCK_API_KEY>`, or
- `Authorization: Bearer <configured MOCK_API_KEY>`.

`MOCK_API_KEY` is server-only. It must never be compiled into PAS browser JavaScript.

### QA Inbox authentication
The QA Inbox uses `QA_INBOX_PASSWORD` + `QA_SESSION_SECRET`. The browser submits the configured QA password to `/api/auth/login`; the server exchanges it for an HttpOnly, SameSite=Lax signed session cookie. The privileged signing secret is never sent to browser code.

Protected QA resources include Inbox listing, message detail, audit history, response history, reply simulation, and Forms attachment access.

### Administrative authentication
Destructive purge operations require `MOCK_ADMIN_TOKEN` through `X-Mock-Admin-Key` or Bearer authorization. The admin credential is intentionally separate from the normal PAS integration credential.

## CORS

`ALLOWED_ORIGINS` is a comma-separated allowlist for cross-origin browser access. Same-origin Mock UI traffic is always allowed. Development additionally permits `http://localhost:3000` and `http://localhost:5173`.

An arbitrary Origin receives `403 CORS_ORIGIN_DENIED`. CORS is defense-in-depth and does not replace authentication.

## Provider webhook verification

`RESEND_WEBHOOK_SECRET` is mandatory in production. Missing verification configuration fails closed. Non-production unsigned webhook testing requires explicit `ALLOW_UNSIGNED_WEBHOOK_TEST=true`.

Existing provider-event IDs remain idempotency guards, and Svix timestamp freshness is enforced by the existing signature verifier.

## Rate limiting

Server-side fixed-window limits are stored in the same persistence abstraction and survive ordinary React/UI behavior:

| Scope | Default |
|---|---:|
| Renewal / Forms send | 60/minute |
| Acknowledgment send | 30/minute |
| QA reply simulation | 30/minute |
| Inbox/message reads | 180/minute |
| Attachment downloads | 120/minute |
| Login | 20/minute |
| Admin operations | 10/minute |

Exceeded limits return `429 RATE_LIMITED` with `Retry-After`.

These limits do not replace requestId idempotency, semantic milestone idempotency, response-event dedupe, or provider-event dedupe.

## Retention

`MOCK_DATA_RETENTION_DAYS` defaults to 30 days and supports 1–3650 days.

Where supported by Upstash, message, attachment, provider lookup/event, offer state, response event, and reply records receive native TTLs. Local JSON development stores expiration metadata and removes expired entries on access.

Indexes are compacted when backing records disappear. Audit/history rows are compacted server-side based on timestamps rather than relying only on a browser being opened.

If a message still retains attachment metadata but the retained QA copy is gone, the attachment endpoint returns `410 ATTACHMENT_PURGED` instead of pretending the file never existed. Historical delivery status remains separate from retention availability.

## Administrative purge

`POST /api/admin/purge`

Supported actions:

- `{"action":"EXPIRED"}` — remove expired retained records and compact indexes.
- `{"action":"ALL","confirm":"PURGE ALL MOCK EMAIL DATA"}` — remove the complete Auto-Renewal mock namespace.

Both require administrative authorization in every environment. Local development may use a disposable `MOCK_ADMIN_TOKEN`, but there is no unauthenticated destructive purge bypass.

## Safe diagnostics

`GET /api/health` returns only high-level configuration state such as service status, storage configured/unavailable, provider configured/unavailable, webhook verification, environment, retention and version.

`GET /api/capabilities` returns safe machine-readable contract capabilities and attachment limits. Neither endpoint returns credentials, URLs containing secrets, tokens, database URLs, or raw environment values.

## Security headers

The middleware applies restrictive response headers including CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame denial and a restrictive Permissions Policy. PDF responses also retain validated `Content-Type`, sanitized `Content-Disposition`, no-store caching and nosniff behavior.

## Privacy boundary

The existing exclusions remain intact. Server logs/audit data must not contain full PDFs/Base64, full SSNs, payment-account details, raw Insurance Score, raw HazardHub, raw Occupancy Insight, provider API keys, webhook secrets, service credentials, session-signing secrets, authorization headers, or admin tokens.

No tracking pixels, device fingerprinting, location tracking, or unnecessary IP-history profiling were added. Rate limiting uses only a short one-way hash in TTL-bound counter keys for unauthenticated callers and does not store the source address in audit rows.
