export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listFamilyResponseEvents } from "@/lib/responses";
import { getOfferFamilyStates } from "@/lib/offers";
import { secureRead } from "@/lib/routeSecurity";

export async function GET(req, { params }) {
  const access = await secureRead(req, "read", "READ_OFFER_RESPONSE_HISTORY");
  if (!access.ok) return access.response;
  const baseOfferNumber = decodeURIComponent(params.baseOfferNumber || "").trim();
  if (!baseOfferNumber) return NextResponse.json({ error: "baseOfferNumber is required" }, { status: 400 });

  const [responses, familyData] = await Promise.all([
    listFamilyResponseEvents(baseOfferNumber, 1000),
    getOfferFamilyStates(baseOfferNumber),
  ]);

  const safeResponses = responses.map((response) => ({
    eventId: response.eventId,
    replyId: response.replyId,
    receivedAt: response.receivedAt,
    processedAt: response.processedAt,
    normalizedDecision: response.normalizedDecision,
    classification: response.classification,
    responseApplicability: response.responseApplicability,
    offerNumber: response.offerNumber,
    baseOfferNumber: response.baseOfferNumber,
    offerVersion: response.offerVersion,
    formsPackageId: response.formsPackageId,
    formsPackageSnapshotId: response.formsPackageSnapshotId,
    messageId: response.messageId,
    threadId: response.threadId,
    requestId: response.requestId,
    responseToken: response.responseToken,
    appliedToCurrentOffer: response.appliedToCurrentOffer,
    lateResponse: response.lateResponse,
    obsoletePackageResponse: response.obsoletePackageResponse,
    supersededOfferResponse: response.supersededOfferResponse,
    requiresManualReview: response.requiresManualReview,
  }));

  return NextResponse.json({
    baseOfferNumber,
    currentOfferNumber: familyData.family.currentOfferNumber,
    currentOfferVersion: familyData.family.currentOfferVersion,
    offers: familyData.states.map((state) => ({
      offerNumber: state.offerNumber,
      baseOfferNumber: state.baseOfferNumber,
      offerVersion: state.offerVersion,
      offerStatus: state.offerStatus,
      supersedesOfferNumber: state.supersedesOfferNumber || null,
      supersededByOfferNumber: state.supersededByOfferNumber || null,
      offerExpirationDate: state.offerExpirationDate || null,
    })),
    responses: safeResponses,
  });
}
