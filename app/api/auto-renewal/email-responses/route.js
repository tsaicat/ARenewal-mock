export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { kvGet, kvSetIfAbsent } from "@/lib/store";
import { recordAudit } from "@/lib/audit";
import { arEmailKey } from "@/lib/keyspace";

// POST /api/auto-renewal/email-responses
// Mock stand-in for the PAS-side inbound gateway. It never issues a policy.
// Responses from an obsolete Forms package snapshot are explicitly HELD rather
// than applied, preserving revised-offer history and exact package correlation.
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

  const dedupeKey = arEmailKey("mock-pas-applied", event.eventId);
  const isFirst = await kvSetIfAbsent(dedupeKey, event);
  if (!isFirst) {
    const prior = await kvGet(arEmailKey("mock-pas-result", event.eventId));
    return NextResponse.json({ ...prior, duplicate: true }, { status: 200 });
  }

  const obsoletePackageResponse = Boolean(event.resolution?.obsoletePackageResponse);
  const requestedStatus = event.customerResponse.pasStatus;

  let status = obsoletePackageResponse ? "HELD" : "APPLIED";
  let customerResponseStatus = obsoletePackageResponse
    ? (event.customerResponse.appliedPasStatus || "Pending")
    : requestedStatus;
  let issueReadiness = "Not Ready";
  const issueReadinessReasons = [];

  if (obsoletePackageResponse) {
    issueReadiness = "Blocked";
    issueReadinessReasons.push("Customer response references an obsolete Auto-Renewal Forms package snapshot and requires review.");
  } else if (requestedStatus === "Declined") {
    issueReadiness = "Blocked";
    issueReadinessReasons.push("Customer declined renewal.");
  } else if (requestedStatus === "Accepted") {
    issueReadinessReasons.push("Payment is required and has not been received.");
  } else {
    issueReadinessReasons.push("Customer response is pending.");
  }

  const response = {
    eventId: event.eventId,
    status,
    offerNumber: event.offerNumber,
    formsPackageId: event.formsPackageId || null,
    formsPackageSnapshotId: event.formsPackageSnapshotId || null,
    responseToken: event.responseToken || null,
    requestedCustomerResponseStatus: requestedStatus,
    customerResponseStatus,
    obsoletePackageResponse,
    appliedToCurrentOffer: !obsoletePackageResponse,
    issueReadiness,
    issueReadinessReasons,
    processedAt: new Date().toISOString(),
  };

  await kvSetIfAbsent(arEmailKey("mock-pas-result", event.eventId), response);
  await recordAudit(obsoletePackageResponse ? "CALLBACK_HELD" : "CALLBACK_APPLIED", {
    eventId: event.eventId,
    offerNumber: event.offerNumber,
    formsPackageId: event.formsPackageId || null,
    formsPackageSnapshotId: event.formsPackageSnapshotId || null,
    customerResponseStatus,
    requestedCustomerResponseStatus: requestedStatus,
    obsoletePackageResponse,
    mockTarget: true,
  });

  return NextResponse.json(response, { status: 200 });
}
