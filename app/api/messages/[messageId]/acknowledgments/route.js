export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { kvDelete, kvGet, kvSetIfAbsent } from "@/lib/store";
import { arEmailKey } from "@/lib/keyspace";
import { getMessage, saveMessage } from "@/lib/messages";
import { getResponseEvent } from "@/lib/responses";
import { sendRenewalEmail } from "@/lib/resend";
import { recordAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import {
  AttachmentValidationError,
  attachmentRequestFingerprint,
  deleteAttachment,
  markAttachmentDelivery,
  prepareUploadedAttachments,
  storeAttachment,
} from "@/lib/attachments";

async function parseRequest(req) {
  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const metadataRaw = form.get("metadata") ?? form.get("payload");
    if (typeof metadataRaw !== "string" || !metadataRaw.trim()) throw new AttachmentValidationError("VALIDATION_FAILED", "metadata JSON is required.");
    let payload;
    try { payload = JSON.parse(metadataRaw); } catch { throw new AttachmentValidationError("VALIDATION_FAILED", "metadata must be valid JSON."); }
    const files = [];
    for (const [key, value] of form.entries()) {
      if ((key === "attachments" || key === "attachment") && value && typeof value.arrayBuffer === "function") files.push(value);
    }
    return { payload, attachments: files.length ? await prepareUploadedAttachments(files) : [], requestMode: "multipart/form-data" };
  }
  if (contentType.includes("application/json") || !contentType) return { payload: await req.json(), attachments: [], requestMode: "application/json" };
  throw new AttachmentValidationError("UNSUPPORTED_CONTENT_TYPE", "Use application/json or multipart/form-data.", 415);
}

function acknowledgmentCopy(type, original, response) {
  if (type === "ACCEPTANCE") {
    return {
      subject: `Renewal acceptance recorded — ${original.sourcePolicyId}`,
      text: `We recorded your acceptance of renewal offer ${original.offerNumber}. This acknowledgment records the response received by PAS and does not by itself mean the renewal policy has been issued.`,
    };
  }
  return {
    subject: `Renewal decline recorded — ${original.sourcePolicyId}`,
    text: `We recorded your decline of renewal offer ${original.offerNumber}. This acknowledgment does not cancel the current policy term.`,
  };
}

export async function POST(req, { params }) {
  const originalMessage = await getMessage(params.messageId);
  if (!originalMessage) return NextResponse.json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }, { status: 404 });

  let parsed;
  try { parsed = await parseRequest(req); } catch (error) {
    return NextResponse.json({ error: error?.message || "Invalid request", code: error?.code || "VALIDATION_FAILED" }, { status: error?.status || 400 });
  }
  const { payload, attachments, requestMode } = parsed;
  const acknowledgmentType = String(payload.acknowledgmentType || "").toUpperCase();
  if (!["ACCEPTANCE", "DECLINE"].includes(acknowledgmentType)) {
    return NextResponse.json({ error: "acknowledgmentType must be ACCEPTANCE or DECLINE", code: "VALIDATION_FAILED" }, { status: 400 });
  }
  if (!payload.requestId || !payload.responseEventId) {
    return NextResponse.json({ error: "requestId and responseEventId are required", code: "VALIDATION_FAILED" }, { status: 400 });
  }

  const responseEvent = await getResponseEvent(payload.responseEventId);
  if (!responseEvent) return NextResponse.json({ error: "Response event not found", code: "RESPONSE_EVENT_NOT_FOUND" }, { status: 404 });
  if (responseEvent.threadId !== originalMessage.threadId || responseEvent.offerNumber !== originalMessage.offerNumber) {
    return NextResponse.json({ error: "Acknowledgment response event does not belong to this renewal conversation", code: "ACKNOWLEDGMENT_CORRELATION_MISMATCH" }, { status: 409 });
  }
  const expectedDecision = acknowledgmentType === "ACCEPTANCE" ? "ACCEPTED" : "DECLINED";
  if (responseEvent.normalizedDecision !== expectedDecision) {
    return NextResponse.json({ error: `Response event is not ${expectedDecision}`, code: "ACKNOWLEDGMENT_DECISION_MISMATCH" }, { status: 409 });
  }

  const requestKey = arEmailKey("ack-request", payload.requestId);
  const signature = {
    requestId: payload.requestId,
    responseEventId: payload.responseEventId,
    acknowledgmentType,
    attachmentFingerprint: attachmentRequestFingerprint(attachments),
  };
  const firstRequest = await kvSetIfAbsent(requestKey, signature);
  if (!firstRequest) {
    const priorId = await kvGet(arEmailKey("ack-request-result", payload.requestId));
    const prior = priorId ? await getMessage(priorId) : null;
    if (prior) return NextResponse.json({ ...prior, duplicate: true }, { status: 200 });
    return NextResponse.json({ error: "Acknowledgment request is already processing", code: "REQUEST_IN_PROGRESS" }, { status: 409 });
  }

  const semanticKey = arEmailKey("acknowledgment", payload.responseEventId, acknowledgmentType);
  const firstSemantic = await kvSetIfAbsent(semanticKey, { requestId: payload.requestId, at: new Date().toISOString() });
  if (!firstSemantic) {
    const priorId = await kvGet(arEmailKey("acknowledgment-result", payload.responseEventId, acknowledgmentType));
    const prior = priorId ? await getMessage(priorId) : null;
    if (prior) {
      await kvSetIfAbsent(arEmailKey("ack-request-result", payload.requestId), priorId);
      return NextResponse.json({ ...prior, semanticDuplicate: true }, { status: 200 });
    }
    await kvDelete(requestKey);
    return NextResponse.json({ error: "Acknowledgment is already processing", code: "ACKNOWLEDGMENT_IN_PROGRESS" }, { status: 409 });
  }

  const messageId = newId("AR-EMAIL-MSG");
  const correlation = {
    formsPackageId: payload.formsPackageId || originalMessage.formsPackageId || null,
    formsPackageSnapshotId: payload.formsPackageSnapshotId || originalMessage.formsPackageSnapshotId || null,
  };
  let storedAttachments = [];
  try {
    for (const attachment of attachments) {
      storedAttachments.push(await storeAttachment(attachment, {
        messageId,
        offerNumber: originalMessage.offerNumber,
        ...correlation,
      }));
    }
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((a) => deleteAttachment(a.attachmentId)));
    await kvDelete(requestKey);
    await kvDelete(semanticKey);
    return NextResponse.json({ error: "Acknowledgment attachment storage failed", code: "ATTACHMENT_STORAGE_FAILED" }, { status: 500 });
  }

  const defaults = acknowledgmentCopy(acknowledgmentType, originalMessage, responseEvent);
  const subject = payload.subject || defaults.subject;
  const text = payload.body?.plainText || payload.plainText || defaults.text;
  const html = payload.body?.html || `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
  const recipient = payload.recipient || originalMessage.recipient;

  const sendResult = await sendRenewalEmail({
    to: recipient.email,
    subject,
    text,
    html,
    messageId,
    attachments,
    headers: {
      "X-Renewal-Offer-Number": originalMessage.offerNumber,
      "X-Renewal-Base-Offer-Number": originalMessage.baseOfferNumber || originalMessage.offerNumber,
      "X-Renewal-Offer-Version": String(originalMessage.offerVersion || 1),
      "X-Renewal-Response-Event-Id": responseEvent.eventId,
      "X-Renewal-Acknowledgment-Type": acknowledgmentType,
    },
  });

  const emailDeliveryStatus = !sendResult.ok ? "FAILED" : sendResult.simulated ? "SIMULATED" : "DELIVERY_PENDING";
  const attachmentStatus = !sendResult.ok ? "DELIVERY_FAILED" : sendResult.simulated ? "SIMULATED" : "DELIVERY_PENDING";
  if (storedAttachments.length) {
    const updates = await Promise.all(storedAttachments.map((a) => markAttachmentDelivery(a.attachmentId, attachmentStatus, null)));
    storedAttachments = updates.map((v, i) => v || storedAttachments[i]);
  }
  const formsDelivery = storedAttachments.length ? {
    status: sendResult.ok ? (sendResult.simulated ? "SIMULATED" : "DELIVERY_PENDING") : "FAILED",
    formsPackageId: correlation.formsPackageId,
    formsPackageSnapshotId: correlation.formsPackageSnapshotId,
    attachmentIds: storedAttachments.map((a) => a.attachmentId),
    attachmentCount: storedAttachments.length,
    deliveredAt: null,
  } : { status: "NOT_REQUESTED", attachmentIds: [], attachmentCount: 0 };

  const message = {
    messageId,
    threadId: originalMessage.threadId,
    requestId: payload.requestId,
    requestMode,
    messageType: "AUTO_RENEWAL_RESPONSE_ACKNOWLEDGMENT",
    communicationType: "ACKNOWLEDGMENT",
    acknowledgmentType,
    originalMessageId: originalMessage.messageId,
    responseEventId: responseEvent.eventId,
    offerNumber: originalMessage.offerNumber,
    baseOfferNumber: originalMessage.baseOfferNumber || originalMessage.offerNumber,
    offerVersion: originalMessage.offerVersion || 1,
    offerStatus: originalMessage.offerStatus || "CURRENT",
    sourcePolicyId: originalMessage.sourcePolicyId,
    customerRef: originalMessage.customerRef,
    recipient,
    subject,
    body: { plainText: text, html },
    createdAt: new Date().toISOString(),
    status: sendResult.ok ? "SENT" : "FAILED",
    outcome: !sendResult.ok ? "ACKNOWLEDGMENT_EMAIL_FAILED" : sendResult.simulated ? "ACKNOWLEDGMENT_SIMULATED" : "ACKNOWLEDGMENT_DELIVERY_PENDING",
    emailDeliveryStatus,
    deliveryMode: sendResult.deliveryMode || (sendResult.simulated ? "SIMULATED" : "REAL_PROVIDER"),
    acceptedAt: sendResult.ok ? new Date().toISOString() : null,
    deliveredAt: null,
    providerMessageId: sendResult.ok && !sendResult.simulated ? sendResult.id || null : null,
    providerDelivery: {
      provider: "RESEND",
      providerMessageId: sendResult.ok && !sendResult.simulated ? sendResult.id || null : null,
      providerDeliveryStatus: emailDeliveryStatus,
    },
    resendSimulated: Boolean(sendResult.simulated),
    resendError: sendResult.ok ? null : sendResult.error,
    formsPackageId: correlation.formsPackageId,
    formsPackageSnapshotId: correlation.formsPackageSnapshotId,
    attachments: storedAttachments,
    formsDelivery,
  };
  await saveMessage(message);
  await kvSetIfAbsent(arEmailKey("ack-request-result", payload.requestId), messageId);
  if (sendResult.ok) {
    await kvSetIfAbsent(arEmailKey("acknowledgment-result", payload.responseEventId, acknowledgmentType), messageId);
  } else {
    await kvDelete(semanticKey);
  }
  await recordAudit(sendResult.ok ? "ACKNOWLEDGMENT_SEND_ACCEPTED" : "ACKNOWLEDGMENT_FAILED", {
    messageId,
    originalMessageId: originalMessage.messageId,
    threadId: originalMessage.threadId,
    offerNumber: originalMessage.offerNumber,
    responseEventId: responseEvent.eventId,
    acknowledgmentType,
    emailDeliveryStatus,
  });

  return NextResponse.json({
    messageId,
    originalMessageId: originalMessage.messageId,
    threadId: originalMessage.threadId,
    requestId: payload.requestId,
    offerNumber: originalMessage.offerNumber,
    baseOfferNumber: originalMessage.baseOfferNumber || originalMessage.offerNumber,
    offerVersion: originalMessage.offerVersion || 1,
    responseEventId: responseEvent.eventId,
    acknowledgmentType,
    emailDeliveryStatus,
    deliveryMode: message.deliveryMode,
    providerMessageId: message.providerMessageId,
    formsDelivery,
    canonicalThreadPreserved: true,
    providerThreadingGuaranteed: false,
  }, { status: sendResult.ok ? 201 : 502 });
}
