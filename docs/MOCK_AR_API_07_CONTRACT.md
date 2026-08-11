# Mock Auto-Renewal Email API v0.5.0 — Secured Contract

## Safe public endpoints

### `GET /api/health`
Returns high-level service/configuration readiness only. It exposes no secrets.

### `GET /api/capabilities`
Returns the API version, attachment limits and supported capabilities including Forms delivery, true provider delivery webhooks, response history, response event IDs, offer lineage, acknowledgments, semantic milestone idempotency, authentication requirement and retention.

## Authentication

### Service calls
Production write calls must send:

```http
X-Mock-Api-Key: <service credential>
```

or a Bearer equivalent.

### QA Inbox

```text
POST /api/auth/login
GET  /api/auth/session
POST /api/auth/logout
```

The login route returns an HttpOnly signed session cookie; no privileged token is returned in JSON.

### Admin

```http
X-Mock-Admin-Key: <admin credential>
```

is required for destructive administration in production.

## Protected lifecycle endpoints

The following v0.4 lifecycle capabilities remain intact but are protected in production:

- `POST /api/renewal-emails`
- `GET /api/renewal-emails`
- `GET /api/messages/{messageId}`
- `GET /api/messages/{messageId}/attachments/{attachmentId}`
- `POST /api/messages/{messageId}/acknowledgments`
- `POST /api/renewal-emails/{messageId}/replies`
- `GET /api/auto-renewal/offers/{baseOfferNumber}/responses`
- `GET /api/audit`

The Forms upload contract remains `multipart/form-data` with JSON `metadata` and actual PDF `attachments` parts.

## Attachment access

The project uses authenticated attachment endpoints rather than permanent public URLs. Knowing `messageId` + `attachmentId` is insufficient in production. Because signed temporary URLs were not selected for this implementation, there is no artificial "download-link expiration" state; authentication and the data-retention lifecycle are independent.

If a retained QA copy has been purged while historical message metadata remains available, the endpoint returns:

```json
{
  "code": "ATTACHMENT_PURGED",
  "error": "The retained QA copy of this attachment has been purged."
}
```

with HTTP `410`.

## Storage failure codes

Attachment persistence failures are mapped to safe structured errors where distinguishable:

- `STORAGE_QUOTA_EXCEEDED`
- `STORAGE_UNAVAILABLE`
- `ATTACHMENT_STORAGE_FAILED`

Raw storage commands, credentials and PDF bytes are not returned.

## CORS

Approved cross-origin browser clients must be listed in `ALLOWED_ORIGINS`. Server-to-server requests without an Origin header are not blocked by browser CORS policy but still require authentication where applicable.

## Webhook

`POST /api/webhooks/resend` remains the provider webhook. In production, `RESEND_WEBHOOK_SECRET` is mandatory and a valid signed, fresh webhook is required. Non-production unsigned test mode is opt-in only.
