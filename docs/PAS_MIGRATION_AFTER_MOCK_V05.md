# PAS migration required after Mock Auto-Renewal API v0.5.0

PAS v7.137.13 remains unchanged by MOCK-AR-API-07.

## Critical authentication constraint

PAS is currently a browser-based React/Vite/IndexedDB application. A long-lived `MOCK_API_KEY` **must not** be embedded in PAS source, environment values exposed to Vite, IndexedDB, Local Storage, or browser-delivered JavaScript.

Therefore the final PAS compatibility work must introduce an appropriate secure server-mediated integration boundary for production/deployed use, such as a same-origin serverless proxy/backend function that owns the Mock service credential. Local development may use the explicitly documented compatibility mode, but production security must not be weakened merely to preserve direct browser-to-Mock calls.

## Recommended final PAS follow-up scope

The final PAS integration prompt should:

1. add a secure gateway/proxy for authenticated Mock v0.5 write/read calls;
2. use `/api/capabilities` to discover supported limits/features where useful;
3. consume the v0.4 asynchronous `DELIVERY_PENDING → DELIVERED / BOUNCED / FAILED` lifecycle;
4. send explicit offer lineage (`baseOfferNumber`, `offerVersion`, `supersedesOfferNumber`);
5. consume canonical response `eventId` and consolidated response history;
6. send Acceptance/Decline acknowledgments through the dedicated endpoint;
7. preserve existing Forms package/file generation and readiness rules;
8. reject `SIMULATED` evidence as production-equivalent readiness evidence;
9. handle `401`, `403`, `429`, `ATTACHMENT_PURGED`, storage failures, and capability/version mismatch with actionable QA messaging;
10. never store the Mock production service credential in IndexedDB or browser code.

A single PAS follow-up after v0.5 is preferable to separate migrations for v0.4 and v0.5.
