# Mock Auto-Renewal Email API v0.4.0 Contract

## Delivery truthfulness

`POST /api/renewal-emails` still accepts both:

- `application/json` for email-only communication;
- `multipart/form-data` with `metadata` JSON + `attachments` PDF parts.

A successful real Resend send request now means **provider send accepted / delivery pending**, not delivered.

Initial real-provider result:

```json
{
  "status": "SENT",
  "emailDeliveryStatus": "DELIVERY_PENDING",
  "deliveryMode": "REAL_PROVIDER",
  "outcome": "EMAIL_SENT_FORMS_PENDING",
  "formsDelivery": { "status": "DELIVERY_PENDING" }
}
```

The signed Resend webhook later processes:

- `email.sent` -> delivery remains pending;
- `email.delivered` -> Email + attached Forms become `DELIVERED`;
- `email.delivery_delayed` -> Email `DELIVERY_DELAYED`, Forms remain pending;
- `email.bounced` -> Email `BOUNCED`, Forms `FAILED`;
- `email.failed` -> Email `FAILED`, Forms `FAILED`;
- `email.received` -> customer-response pipeline.

Provider event identity uses the webhook event/Svix identity and is idempotent.

## Simulation

No provider credential is silently converted to successful external delivery.

Without `RESEND_API_KEY`:

- `ALLOW_SIMULATED_EMAIL=true` -> explicit `SIMULATED` result;
- otherwise -> `EMAIL_PROVIDER_NOT_CONFIGURED` and send failure.

A simulated result is never represented as real `DELIVERED` evidence.

## Offer lineage

New clients may provide:

```json
{
  "baseOfferNumber": "ARN-1001",
  "offerNumber": "ARN-1001-R2",
  "offerVersion": 2,
  "supersedesOfferNumber": "ARN-1001",
  "offerExpirationDate": "2026-09-01T23:59:59Z",
  "responseDueDate": "2026-08-28T23:59:59Z",
  "renewalEffectiveDate": "2026-09-02"
}
```

Old clients may omit these fields; the offer is then treated as its own family/version 1 and no revision relationship is fabricated.

Explicit supersession marks the prior offer `SUPERSEDED` and preserves both histories.

## Customer response event

Every stored response exposes stable provenance equivalent to:

```text
replyId
eventId
messageId
threadId
requestId
responseToken
offerNumber
baseOfferNumber
offerVersion
formsPackageId
formsPackageSnapshotId
receivedAt
processedAt
classification
normalizedDecision
responseApplicability
appliedToCurrentOffer
obsoletePackageResponse
supersededOfferResponse
lateResponse
requiresManualReview
```

`normalizedDecision` and `responseApplicability` are deliberately separate. A real ACCEPT can therefore be preserved as `ACCEPTED` while applicability is `LATE` or `SUPERSEDED_OFFER` and `appliedToCurrentOffer=false`.

## Response history

```http
GET /api/auto-renewal/offers/{baseOfferNumber}/responses
```

Returns chronological canonical response events across the explicit offer family, including superseded revisions.

## Milestone idempotency

Normal sends use both:

1. `requestId` idempotency; and
2. semantic communication identity:

```text
baseOfferNumber + offerVersion + noticeMilestone + communicationType
```

A different request ID cannot create a second normal send for the same completed semantic communication.

## Controlled resend

Use `POST /api/renewal-emails` with:

```json
{
  "resend": true,
  "originalMessageId": "AR-EMAIL-MSG-...",
  "resendReason": "QA requested a controlled resend",
  "resendActor": { "name": "QA User" }
}
```

The original message remains immutable; the new message retains offer/package correlation and the same Mock thread.

## Acknowledgment delivery

```http
POST /api/messages/{messageId}/acknowledgments
```

Required metadata:

```json
{
  "requestId": "AR-EMAIL-REQ-ACK-...",
  "responseEventId": "AR-EMAIL-EVENT-...",
  "acknowledgmentType": "ACCEPTANCE"
}
```

`acknowledgmentType` supports `ACCEPTANCE` and `DECLINE`. The response event must belong to the same offer/thread and have the matching normalized decision.

The endpoint accepts JSON and optional multipart PDF attachment delivery. The Mock canonical thread is preserved. Provider/client-visible threading is not guaranteed because the service does not possess a guaranteed RFC Message-ID relationship for every provider/client combination.

## Attachment limits

- `application/pdf` only;
- maximum 3 attachments;
- maximum 3 MB per file;
- maximum 3 MB total.

Actual bytes are validated and SHA-256 hashed. Normal message APIs return metadata only, never raw Base64.

## PAS compatibility

PAS v7.137.13 can continue using the old required request fields, but it does **not yet consume the complete v0.4 contract**. A later PAS integration should add:

- `baseOfferNumber`, `offerVersion`, and `supersedesOfferNumber`;
- refresh/polling of asynchronous `DELIVERY_PENDING -> DELIVERED/BOUNCED/FAILED` evidence;
- canonical response `eventId`;
- consolidated response-history endpoint;
- acknowledgment delivery endpoint;
- explicit handling of `SIMULATED` as non-production delivery evidence.
