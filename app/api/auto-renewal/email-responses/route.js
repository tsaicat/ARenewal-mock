export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { kvGet, kvSetIfAbsent } from "@/lib/store";
import { recordAudit } from "@/lib/audit";
import { arEmailKey } from "@/lib/keyspace";

// Mock stand-in for the PAS-side callback. It mirrors the lifecycle semantics
// but never issues or changes an actual PAS policy.
export async function POST(req) {
  let event;
  try { event = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const required = ["eventId", "offerNumber", "customerResponse"];
  const missing = required.filter((f) => !event[f]);
  if (missing.length) return NextResponse.json({ error: "Missing required fields", missing }, { status: 400 });

  const dedupeKey = arEmailKey("mock-pas-applied", event.eventId);
  const isFirst = await kvSetIfAbsent(dedupeKey, event);
  if (!isFirst) {
    const prior = await kvGet(arEmailKey("mock-pas-result", event.eventId));
    return NextResponse.json({ ...prior, duplicate: true }, { status: 200 });
  }

  const applicability = event.resolution?.responseApplicability || (event.resolution?.obsoletePackageResponse ? "OBSOLETE_PACKAGE" : "CURRENT");
  const appliedToCurrentOffer = event.resolution?.appliedToCurrentOffer !== false && applicability === "CURRENT";
  const requestedStatus = event.customerResponse.pasStatus;
  const status = appliedToCurrentOffer ? "APPLIED" : "HELD";
  const customerResponseStatus = appliedToCurrentOffer ? requestedStatus : (event.customerResponse.appliedPasStatus || "Pending");
  let issueReadiness = "Not Ready";
  const issueReadinessReasons = [];

  if (!appliedToCurrentOffer) {
    issueReadiness = "Blocked";
    issueReadinessReasons.push(`Customer response applicability is ${applicability}; manual/service review is required.`);
  } else if (requestedStatus === "Declined") {
    issueReadiness = "Blocked";
    issueReadinessReasons.push("Customer declined renewal.");
  } else if (requestedStatus === "Accepted") {
    issueReadinessReasons.push("Payment and all other PAS readiness requirements must still be satisfied.");
  } else {
    issueReadinessReasons.push("Customer response is pending/manual review.");
  }

  const response = {
    eventId: event.eventId,
    status,
    offerNumber: event.offerNumber,
    baseOfferNumber: event.baseOfferNumber || event.offerNumber,
    offerVersion: event.offerVersion || 1,
    formsPackageId: event.formsPackageId || null,
    formsPackageSnapshotId: event.formsPackageSnapshotId || null,
    responseToken: event.responseToken || null,
    requestedCustomerResponseStatus: requestedStatus,
    customerResponseStatus,
    normalizedDecision: event.customerResponse.normalizedDecision || null,
    responseApplicability: applicability,
    obsoletePackageResponse: Boolean(event.resolution?.obsoletePackageResponse),
    supersededOfferResponse: Boolean(event.resolution?.supersededOfferResponse),
    lateResponse: Boolean(event.resolution?.lateResponse),
    appliedToCurrentOffer,
    issueReadiness,
    issueReadinessReasons,
    processedAt: new Date().toISOString(),
  };

  await kvSetIfAbsent(arEmailKey("mock-pas-result", event.eventId), response);
  await recordAudit(appliedToCurrentOffer ? "CALLBACK_APPLIED" : "CALLBACK_HELD", {
    eventId: event.eventId,
    offerNumber: event.offerNumber,
    baseOfferNumber: event.baseOfferNumber || event.offerNumber,
    offerVersion: event.offerVersion || 1,
    customerResponseStatus,
    requestedCustomerResponseStatus: requestedStatus,
    responseApplicability: applicability,
    appliedToCurrentOffer,
    mockTarget: true,
  });
  return NextResponse.json(response, { status: 200 });
}
