# Mock Auto-Renewal Email API — v0.5.0

Training/QA mock for PAS Auto-Renewal email, Forms delivery, customer responses, provider delivery evidence, offer revisions, acknowledgments, and QA Inbox verification.

## What v0.5.0 adds

MOCK-AR-API-07 preserves all v0.4.0 lifecycle behavior and adds production-oriented security and operations hardening:

- PAS write authentication (`MOCK_API_KEY`);
- QA Inbox login with HttpOnly signed session cookie;
- separate admin authorization for purge operations;
- restricted configurable CORS (`ALLOWED_ORIGINS`);
- production fail-closed Resend webhook verification;
- webhook replay/idempotency preservation;
- server-side API rate limiting;
- explicit configurable retention (`MOCK_DATA_RETENTION_DAYS`, default 30 days);
- authenticated Forms PDF access;
- retention-aware `ATTACHMENT_PURGED` state;
- safe `/api/health` and `/api/capabilities` endpoints;
- security headers and safe PDF response headers;
- safe storage failure codes;
- server-side audit of unauthorized/admin/attachment events without credential logging.

## Preserved v0.4 lifecycle

- JSON email-only requests;
- multipart real PDF Forms attachments;
- provider send acceptance vs real delivery distinction;
- `email.sent`, `email.delivered`, delayed, bounced and failed evidence;
- immutable offer-family/version lineage;
- canonical response event IDs;
- late/superseded response applicability;
- response-history endpoint;
- requestId + semantic milestone idempotency;
- controlled resend;
- Acceptance/Decline acknowledgment delivery;
- QA Inbox and PAS callbacks.

## Development

```bash
npm install
npm run dev
```

Copy `.env.example` into your environment and configure only the values you need.

In local development, authentication can remain disabled unless `REQUIRE_API_AUTH=true` / `REQUIRE_QA_AUTH=true` are set. The UI clearly labels development-only security/provider exceptions. Unsigned webhook testing is disabled unless `ALLOW_UNSIGNED_WEBHOOK_TEST=true`.

## Production/deployed requirements

At minimum configure:

```text
MOCK_ENV_MODE=production
MOCK_API_KEY
QA_INBOX_PASSWORD
QA_SESSION_SECRET
MOCK_ADMIN_TOKEN
ALLOWED_ORIGINS
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

`MOCK_API_KEY` is a server-side service credential. **Do not place it in PAS Vite/browser environment variables or IndexedDB.** PAS v7.137.13 requires a later secure gateway/proxy integration before using v0.5 production authentication.

## Safe discovery

```text
GET /api/health
GET /api/capabilities
```

These endpoints intentionally contain no keys, tokens, secret values, database URLs, or provider credentials.

## Attachment limits

- PDF (`application/pdf`) only;
- maximum 3 files;
- maximum 3 MB per file;
- maximum 3 MB total per request;
- PDF signature validated;
- SHA-256 persisted as metadata;
- filenames sanitized;
- actual bytes retained according to the configured data-retention lifecycle.

## Documentation

- `docs/MOCK_AR_API_06_CONTRACT.md` — lifecycle/delivery contract introduced in v0.4.
- `docs/MOCK_AR_API_07_SECURITY.md` — v0.5 security, CORS, rate limit, retention and operations model.
- `docs/MOCK_AR_API_07_CONTRACT.md` — secured endpoint contract.
- `docs/PAS_MIGRATION_AFTER_MOCK_V05.md` — required final PAS compatibility work.
- `docs/MOCK_AR_API_07_VERIFICATION.md` — targeted verification results.

This remains a training mock. It does not create legal coverage or replace a production policy administration/email platform.
