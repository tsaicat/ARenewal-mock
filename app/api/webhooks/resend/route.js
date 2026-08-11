export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { messageIdFromReplyAddress } from "@/lib/resend";
import { processReply } from "@/lib/replyProcessor";
import { recordAudit } from "@/lib/audit";
import { getMessage } from "@/lib/messages";
import { verifySvixSignature } from "@/lib/webhookSignature";
import { applyProviderDeliveryEvent, isOutboundDeliveryEvent, providerEventIdentity } from "@/lib/delivery";

async function fetchReceivedEmail(emailId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { data: null, error: { message: "RESEND_API_KEY is not set" } };

  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { data: null, error: payload?.error || payload || { message: `HTTP ${response.status}` } };
    return { data: payload?.data || payload, error: null };
  } catch (error) {
    return { data: null, error: { message: error?.message || "Receiving API request failed" } };
  }
}

async function parseAndVerify(req) {
  const rawBody = await req.text();
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  let event;

  if (secret) {
    verifySvixSignature({ rawBody, id: svixId, timestamp: svixTimestamp, signature: svixSignature, secret });
    event = JSON.parse(rawBody);
  } else {
    // MOCK-AR-API-07 will harden production webhook configuration. For this
    // lifecycle prompt, preserve existing dev/test compatibility when no
    // signing secret is configured.
    event = JSON.parse(rawBody);
  }
  return { event, svixId, rawBody };
}

export async function POST(req) {
  let parsed;
  try {
    parsed = await parseAndVerify(req);
  } catch (err) {
    await recordAudit("WEBHOOK_SIGNATURE_INVALID", {
      reason: `Signature/payload check failed: ${err?.message || String(err)}`,
      hasSvixId: Boolean(req.headers.get("svix-id")),
      hasSvixTimestamp: Boolean(req.headers.get("svix-timestamp")),
      hasSvixSignature: Boolean(req.headers.get("svix-signature")),
    });
    return NextResponse.json({ error: "Invalid webhook signature or payload" }, { status: 401 });
  }

  const { event, svixId } = parsed;
  const providerEventId = providerEventIdentity({ svixId, event });

  if (isOutboundDeliveryEvent(event.type)) {
    const result = await applyProviderDeliveryEvent({ event, providerEventId });
    return NextResponse.json({ received: true, providerEventId, ...result }, { status: result.resolved === false ? 202 : 200 });
  }

  if (event.type !== "email.received") {
    await recordAudit("WEBHOOK_EVENT_IGNORED", { providerEventId, reason: `Unsupported event type "${event.type}".` });
    return NextResponse.json({ received: true, ignored: event.type, providerEventId });
  }

  const emailId = event.data?.email_id;
  const toAddresses = event.data?.to || [];
  if (!emailId) {
    await recordAudit("WEBHOOK_BAD_PAYLOAD", { providerEventId, reason: "email.received did not contain data.email_id." });
    return NextResponse.json({ error: "Missing email_id" }, { status: 400 });
  }

  let messageId = null;
  for (const addr of toAddresses) {
    messageId = messageIdFromReplyAddress(addr);
    if (messageId) break;
  }
  if (!messageId) {
    await recordAudit("WEBHOOK_ADDRESS_NOT_RESOLVED", { providerEventId, to: toAddresses, emailId });
    return NextResponse.json({ received: true, resolved: false, providerEventId });
  }

  const message = await getMessage(messageId);
  if (!message) {
    await recordAudit("WEBHOOK_MESSAGE_NOT_FOUND", { providerEventId, messageId, emailId });
    return NextResponse.json({ received: true, resolved: false, providerEventId });
  }

  let fullEmail = { text: "", subject: event.data?.subject, from: event.data?.from };
  const { data, error } = await fetchReceivedEmail(emailId);
  if (error) {
    await recordAudit("WEBHOOK_RECEIVING_API_FAILED", { providerEventId, messageId, emailId, reason: error?.message || "Receiving API failed" });
  } else if (data) {
    fullEmail = data;
  }

  const result = await processReply({
    messageId,
    replyId: emailId,
    from: fullEmail.from || event.data?.from,
    subject: fullEmail.subject || event.data?.subject,
    plainText: fullEmail.text || "",
    receivedAt: event.created_at || event.data?.created_at,
    rawSource: event,
    requestUrl: req.url,
  });

  if (result.error === "MESSAGE_NOT_FOUND") return NextResponse.json({ received: true, resolved: false, providerEventId });

  return NextResponse.json({
    received: true,
    resolved: true,
    providerEventId,
    duplicate: Boolean(result.duplicate),
    eventId: result.reply?.eventId || result.callback?.eventId || null,
    classification: result.classification?.classification ?? result.reply?.classification,
    normalizedDecision: result.reply?.normalizedDecision || null,
    responseApplicability: result.reply?.responseApplicability || null,
    appliedToCurrentOffer: result.reply?.appliedToCurrentOffer ?? null,
  });
}
