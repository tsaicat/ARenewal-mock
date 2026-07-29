export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { kvGet, kvSetIfAbsent } from "@/lib/store";
import { recordAudit } from "@/lib/audit";
import { arEmailKey } from "@/lib/keyspace";

// POST /api/auto-renewal/email-responses
//
// Mock stand-in for the PAS-side inbound gateway described in the
// handoff doc's "Critical architecture gap": PAS is currently a
// browser-only app with no server API, so this endpoint simulates what
// a real PAS gateway would do with the AUTO_RENEWAL_CUSTOMER_RESPONSE
// callback event — validate idempotency, "apply" the response, and
// return the shape PAS is expected to return once it has a real one.
//
// This never issues a policy and never touches payment/reports/UW —
// per the handoff doc's safety rules, an email acceptance only ever
// changes customerResponseStatus; PAS remains the system of record for
// everything else (§ "Safety and business rules").
export async function POST(req) {
  let event;
  try {
    event = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const required = ["eventId", "offerNumber", "customerResponse"];
  const missing = required.filter((f) => !event[f]);
  if (missing.length) {
    return NextResponse.json({ error: "Missing required fields", missing }, { status: 400 });
  }

  // Idempotent on eventId: a repeated callback must not create duplicate
  // response history or communication rows on the (simulated) PAS side.
  const dedupeKey = arEmailKey("mock-pas-applied", event.eventId);
  const isFirst = await kvSetIfAbsent(dedupeKey, event);
  if (!isFirst) {
    const prior = await kvGet(arEmailKey("mock-pas-result", event.eventId));
    return NextResponse.json({ ...prior, duplicate: true }, { status: 200 });
  }

  const pasStatus = event.customerResponse.pasStatus;

  // Mirror BRD-005 §6.6.1 issue-readiness reasons for the two statuses
  // an email reply can actually move: Accepted and Declined. Payment is
  // always modeled as still pending in this mock, since the email
  // gateway never receives or reports payment state — a real PAS would
  // recompute this from its own payment/report/UW/notice state.
  let issueReadiness = "Not Ready";
  const issueReadinessReasons = [];
  if (pasStatus === "Declined") {
    issueReadiness = "Blocked";
    issueReadinessReasons.push("Customer declined renewal.");
  } else if (pasStatus === "Accepted") {
    issueReadinessReasons.push("Payment is required and has not been received.");
  } else {
    issueReadinessReasons.push("Customer response is pending.");
  }

  const response = {
    eventId: event.eventId,
    status: "APPLIED",
    offerNumber: event.offerNumber,
    customerResponseStatus: pasStatus,
    issueReadiness,
    issueReadinessReasons,
    processedAt: new Date().toISOString(),
  };

  await kvSetIfAbsent(arEmailKey("mock-pas-result", event.eventId), response);
  await recordAudit("CALLBACK_APPLIED", {
    eventId: event.eventId,
    offerNumber: event.offerNumber,
    customerResponseStatus: pasStatus,
    mockTarget: true,
  });

  return NextResponse.json(response, { status: 200 });
}
