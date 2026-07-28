import { NextResponse } from "next/server";
import { kvGet, kvSetIfAbsent } from "@/lib/store";
import { saveMessage, listMessages } from "@/lib/messages";
import { buildRenewalEmail } from "@/lib/templates";
import { sendRenewalEmail } from "@/lib/resend";
import { recordAudit } from "@/lib/audit";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "@/lib/privacy";
import { setOfferState } from "@/lib/offers";
import { newId } from "@/lib/ids";

export const dynamic = "force-dynamic";

// POST /api/renewal-emails
// Accepts a renewal offer payload per auto-renewal-email-contract-starter.json,
// sends the email via Resend, and stores the message.
export async function POST(req) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const required = ["requestId", "offerNumber", "sourcePolicyId", "recipient", "subject"];
  const missing = required.filter((f) => !payload[f]);
  if (missing.length) {
    return NextResponse.json(
      { error: "Missing required fields", missing },
      { status: 400 }
    );
  }
  if (!payload.recipient?.email) {
    return NextResponse.json({ error: "recipient.email is required" }, { status: 400 });
  }

  // --- idempotency on requestId: sending the same request twice returns the original result ---
  const idempotencyKey = `outbound-request:${payload.requestId}`;
  const isFirst = await kvSetIfAbsent(idempotencyKey, { requestId: payload.requestId, at: new Date().toISOString() });
  if (!isFirst) {
    const priorMessageId = await kvGet(`outbound-request-result:${payload.requestId}`);
    if (priorMessageId) {
      const { getMessage } = await import("@/lib/messages");
      const prior = await getMessage(priorMessageId);
      if (prior) {
        return NextResponse.json(
          {
            messageId: prior.messageId,
            threadId: prior.threadId,
            requestId: prior.requestId,
            offerNumber: prior.offerNumber,
            status: prior.status,
            acceptedAt: prior.acceptedAt,
            deliveredAt: prior.deliveredAt,
            duplicate: true,
          },
          { status: 200 }
        );
      }
    }
  }

  // --- privacy: never store/send SSN, DOB, payment account, or raw report data ---
  const privacyFieldsStripped = findPrivacyFieldsPresent(payload);
  const safePayload = stripPrivacyFields(payload);

  const messageId = newId("MSG");
  const threadId = newId("THREAD");
  const acceptedAt = new Date().toISOString();

  // --- template selection (60/45/15-day) unless caller supplied a full body ---
  let subject = safePayload.subject;
  let html = safePayload.body?.html;
  let plainText = safePayload.body?.plainText;
  let milestone = safePayload.offer?.noticeMilestone ?? null;

  if (!html || !plainText) {
    const built = buildRenewalEmail({
      sourcePolicyId: safePayload.sourcePolicyId,
      recipient: safePayload.recipient,
      offer: safePayload.offer || {},
    });
    subject = subject || built.subject;
    html = html || built.html;
    plainText = plainText || built.plainText;
    milestone = milestone ?? built.milestone;
  }

  const sendResult = await sendRenewalEmail({
    to: safePayload.recipient.email,
    subject,
    html,
    text: plainText,
    messageId,
    headers: { "X-Renewal-Offer-Number": safePayload.offerNumber, "X-Renewal-Message-Id": messageId },
  });

  const status = sendResult.ok ? "SENT" : "FAILED";
  const deliveredAt = sendResult.ok ? new Date().toISOString() : null;

  const message = {
    messageId,
    threadId,
    requestId: safePayload.requestId,
    messageType: safePayload.messageType || "AUTO_RENEWAL_OFFER",
    offerNumber: safePayload.offerNumber,
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    recipient: safePayload.recipient,
    subject,
    body: { plainText, html },
    offer: safePayload.offer || {},
    milestone,
    responseInstructions: safePayload.responseInstructions || {},
    callback: safePayload.callback || {},
    sentBy: safePayload.sentBy || {},
    createdAt: safePayload.createdAt || acceptedAt,
    status,
    acceptedAt,
    deliveredAt,
    resendId: sendResult.id || null,
    resendSimulated: Boolean(sendResult.simulated),
    resendError: sendResult.ok ? null : sendResult.error,
    privacyFieldsStripped,
  };

  await saveMessage(message);
  await kvSetIfAbsent(`outbound-request-result:${payload.requestId}`, messageId);

  await setOfferState(safePayload.offerNumber, {
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    customerResponseStatus: "Pending",
    emailGateway: {
      messageId,
      threadId,
      deliveryStatus: status,
      deliveryAcceptedAt: acceptedAt,
      deliveredAt: deliveredAt || "",
    },
  });

  await recordAudit("MESSAGE_SENT", {
    messageId,
    offerNumber: safePayload.offerNumber,
    requestId: safePayload.requestId,
    milestone,
    status,
    privacyFieldsStripped,
    simulated: Boolean(sendResult.simulated),
  });

  return NextResponse.json(
    {
      messageId,
      threadId,
      requestId: safePayload.requestId,
      offerNumber: safePayload.offerNumber,
      status,
      acceptedAt,
      deliveredAt,
      milestone,
      simulated: Boolean(sendResult.simulated),
    },
    { status: sendResult.ok ? 201 : 502 }
  );
}

// GET /api/renewal-emails — list stored messages (for the inbox UI).
export async function GET() {
  const messages = await listMessages(200);
  return NextResponse.json({ messages });
}
