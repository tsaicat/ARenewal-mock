# PAS Follow-up Required After Mock AR API v0.4.0

PAS v7.137.13 remains backward-compatible with the old required send fields, but it cannot yet consume all new v0.4 lifecycle evidence.

A later PAS integration should:

1. Send explicit `baseOfferNumber`, `offerVersion`, `supersedesOfferNumber`, response due date, and offer expiration where available.
2. Treat the initial real-provider result as delivery pending, not final Forms delivery.
3. Refresh delivery evidence until it becomes Delivered, Delayed, Bounced, or Failed.
4. Reject `SIMULATED` evidence as production issue-readiness proof.
5. Use canonical response `eventId` instead of treating `replyId` as the response-event identifier.
6. Prefer consolidated offer-family response history when synchronizing responses.
7. Use the acknowledgment endpoint for Renewal Acceptance Confirmation / Renewal Decline Acknowledgment delivery where desired.
8. Preserve existing fallback behavior while the Mock API is run in backward-compatibility mode.

Do not apply this PAS follow-up before MOCK-AR-API-07 is finalized if that security prompt introduces authentication or capabilities discovery; those changes should be integrated into PAS together to avoid two gateway migrations.
