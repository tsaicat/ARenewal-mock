# NPC-01 — Non-Payment Cancellation Notice Integration (Mock API v0.6.0)

## Scope and boundaries

This is **Step 1** of PAS PRE-OOS-05 Phase C completion: reuse the existing Mock Email API / Resend provider for synthetic Academy non-payment Cancellation notices. It adds message delivery evidence only. It does **not** perform PAS Cancellation scheduling, policy termination, Billing financial posting, earned/unearned premium calculation, or create legally authorized state-specific notices. Those are separate PAS-side prerequisites and Phase C certification gates.

This service is not a real insurance carrier notification or proof of statutory notice. Provider `email.delivered` means the provider reported delivery, not that a recipient opened/read it. The PAS Academy may use it as training evidence only when verified and permitted by its synthetic state table.

## Non-Payment endpoints

- `POST /api/cancellation-notices` — authenticated PAS service write. JSON for notice email without PDF; `multipart/form-data` with `metadata` JSON and up to three `attachments` PDF files otherwise.
- `GET /api/cancellation-notices/{messageId}` — authenticated service/QA read. Returns delivery status and `notice` evidence only for a **verified, signed** Resend `email.delivered` event. Polling and reading this endpoint do not change policy state.
- Existing signed `POST /api/webhooks/resend` recognizes provider delivery events for both Renewal and Cancellation messages. Cancellation messages never call `setOfferState` or Renewal reply-classification routines.
- Existing QA Inbox can inspect the new messages, provider event metadata and PDFs without activating a Renewal offer or simulated Renewal reply.

### Request example (synthetic, **no real customer data**)

```json
{
  "requestId": "NPC-REQ-001",
  "policyId": "HO2026999999-00",
  "customerRef": "ACADEMY-CUSTOMER-001",
  "noticeId": "NPC-NOTICE-001",
  "noticeSnapshotId": "FROZEN-NPC-001",
  "messageType": "NON_PAYMENT_CANCELLATION_NOTICE",
  "recipient": { "email": "academy@example.test", "name": "Example Insured" },
  "subject": "Academy notice concerning policy HO2026999999-00",
  "body": { "plainText": "Training-only notice text from the certified PAS notice generator." }
}
```

The API **does not invent notice content** from delinquency data and will not assert legal waiting periods. PAS must supply its approved document text. A PDF requires `formsPackageId` and `formsPackageSnapshotId` in multipart metadata, with actual PDF bytes, and retention of the original notice snapshot in PAS. Attachments are checked as PDF, limited to 3 files / 3 MiB total; no attachment is reported as delivered until a provider delivery event.

Credentials belong only on the **server**. Use `X-Mock-Api-Key` or bearer service credential; never place it in the PAS browser bundle. Production must have persistent Upstash, configured Resend sender domain and `RESEND_WEBHOOK_SECRET`, and a valid signature on delivery callbacks.

### Response before provider delivery

```json
{
  "messageId": "NPC-MSG-...",
  "policyId": "HO2026999999-00",
  "noticeId": "NPC-NOTICE-001",
  "noticeSnapshotId": "FROZEN-NPC-001",
  "deliveryStatus": "DELIVERY_PENDING",
  "deliveryEvidenceVerified": false,
  "notice": null
}
```

### Response after a verified provider `email.delivered` event

```json
{
  "messageId": "NPC-MSG-...",
  "deliveryStatus": "DELIVERED",
  "deliveryEvidenceVerified": true,
  "notice": {
    "deliveryStatus": "DELIVERED",
    "deliveryEventId": "svix-provider-event-id",
    "externalMessageId": "resend-provider-email-id",
    "provider": "RESEND",
    "deliveredAt": "2026-10-28T12:01:00Z",
    "evidenceSource": "EXTERNAL_PROVIDER_DELIVERY_WEBHOOK"
  }
}
```

The `notice` subobject is intentionally shaped to pass PAS `validateNonPaymentDelivery()`. Only the verified webhook can set `signatureVerified=true`. Unsigned development test events and local simulated email never produce a non-null `notice` object. A later bounce/failure makes `notice:null` again.

## Idempotency and controlled resend

`requestId` is reserved across retries and must be reused with identical policy/recipient/content/PDF fingerprint. Reuse with altered content receives `409 IDEMPOTENCY_CONFLICT`. A policy + notice snapshot is protected against duplicate normal sends; a second requestId for the same snapshot is rejected. A controlled resend requires `resend:true`, `originalMessageId`, `resendReason`, `resendActor`, the same policy/notice/snapshot/recipient, and identical PDF content if present. It creates an independently tracked message and provider event.

## Testing and limitations

Existing Auto-Renewal endpoints, offer chronology, replies, attachments and auth are unchanged in meaning. The mailer is renamed in QA Inbox, not the existing Renewal API contract. Source tests demonstrate validation, idempotency fingerprints, simulated vs signed evidence, bounce and cross-namespace isolation. A production Vercel/Resend webhook end-to-end test is required before PAS consumption is considered certified.

Retention defaults to 30 days. PAS must persist an immutable, independently auditable copy of verified delivery evidence and the frozen notice snapshot before using it for a scheduled Cancellation; do not rely on this Mock service's temporary QA retention as sole authority. No live PAS integration is made in this release.

## Step 2 (PAS work — NOT IMPLEMENTED HERE)

Add secure PAS server-side send/status proxy with the existing service authentication architecture; wire immutable notice snapshot identity, genuine delivery-status polling, effective-date/timezone check, Billing-safe pending schedule; then finish issued termination/Billing/Forms certification and browser UAT before Phase D and OOS-05.
