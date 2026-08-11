export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getMessage } from "@/lib/messages";
import { processReply } from "@/lib/replyProcessor";
import { newId } from "@/lib/ids";

export async function POST(req, { params }) {
  const { messageId } = params;
  const message = await getMessage(messageId);
  if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

  let payload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!payload.plainText || !payload.from) return NextResponse.json({ error: "from and plainText are required" }, { status: 400 });

  const replyId = payload.replyId || newId("AR-EMAIL-REPLY");
  const result = await processReply({
    messageId,
    replyId,
    from: payload.from,
    subject: payload.subject || `Re: ${message.subject}`,
    plainText: payload.plainText,
    receivedAt: payload.receivedAt,
    rawSource: payload,
    requestUrl: req.url,
  });

  if (result.error === "MESSAGE_NOT_FOUND") return NextResponse.json({ error: "Message not found" }, { status: 404 });
  if (result.duplicate) {
    return NextResponse.json({
      replyId,
      eventId: result.reply?.eventId || null,
      messageId,
      duplicate: true,
      classification: result.reply?.classification,
      normalizedDecision: result.reply?.normalizedDecision,
      responseApplicability: result.reply?.responseApplicability,
      appliedToCurrentOffer: result.reply?.appliedToCurrentOffer,
    });
  }

  return NextResponse.json({
    replyId,
    eventId: result.reply.eventId,
    messageId,
    threadId: message.threadId,
    requestId: message.requestId || null,
    offerNumber: message.offerNumber,
    baseOfferNumber: message.baseOfferNumber || message.offerNumber,
    offerVersion: message.offerVersion || 1,
    classification: result.reply.classification,
    normalizedDecision: result.reply.normalizedDecision,
    confidence: result.reply.confidence,
    matchedPhrase: result.reply.matchedPhrase,
    receivedAt: result.reply.receivedAt,
    responseApplicability: result.reply.responseApplicability,
    formsPackageId: message.formsPackageId || null,
    formsPackageSnapshotId: message.formsPackageSnapshotId || null,
    responseToken: message.responseToken || message.responseInstructions?.responseToken || null,
    obsoletePackageResponse: Boolean(result.reply.obsoletePackageResponse),
    supersededOfferResponse: Boolean(result.reply.supersededOfferResponse),
    lateResponse: Boolean(result.reply.lateResponse),
    appliedToCurrentOffer: result.reply.appliedToCurrentOffer,
    requiresManualReview: result.reply.requiresManualReview,
    callbackStatus: result.callback.result?.body?.status || (result.callback.result?.ok ? "APPLIED" : "PENDING"),
    callbackEventId: result.callback.eventId,
  }, { status: 201 });
}
