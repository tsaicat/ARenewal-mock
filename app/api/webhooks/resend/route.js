export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { messageIdFromReplyAddress } from "@/lib/resend";
import { processReply } from "@/lib/replyProcessor";
import { recordAudit } from "@/lib/audit";
import { getMessage } from "@/lib/messages";
import { verifySvixSignature } from "@/lib/webhookSignature";

async function fetchReceivedEmail(emailId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { data: null, error: { message: "RESEND_API_KEY is not set" } };

  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { data: null, error: payload?.error || payload || { message: `HTTP ${response.status}` } };
    }
    return { data: payload?.data || payload, error: null };
  } catch (error) {
    return { data: null, error: { message: error?.message || "Receiving API request failed" } };
  }
}

// POST /api/webhooks/resend
// Receives Resend's email.received webhook. Signature verification follows
// Svix/Standard Webhooks semantics directly, and the full received email body
// is fetched with Resend's Receiving REST API. No Resend SDK dependency is
// required by the mock service.
export async function POST(req) {
  const rawBody = await req.text();

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  let event;
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  if (secret) {
    try {
      verifySvixSignature({
        rawBody,
        id: svixId,
        timestamp: svixTimestamp,
        signature: svixSignature,
        secret,
      });
      event = JSON.parse(rawBody);
    } catch (err) {
      await recordAudit("WEBHOOK_SIGNATURE_INVALID", {
        reason: `Signature check failed: ${err?.message || String(err)}`,
        hasSvixId: Boolean(svixId),
        hasSvixTimestamp: Boolean(svixTimestamp),
        hasSvixSignature: Boolean(svixSignature),
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // Local/dev compatibility mode: accept unsigned payloads only when no
    // webhook secret has been configured.
    try {
      event = JSON.parse(rawBody);
    } catch {
      await recordAudit("WEBHOOK_BAD_PAYLOAD", {
        reason: "Body was not valid JSON and no secret was configured.",
      });
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (event.type !== "email.received") {
    await recordAudit("WEBHOOK_EVENT_IGNORED", {
      reason: `Received event type "${event.type}", only email.received is handled.`,
    });
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const emailId = event.data?.email_id;
  const toAddresses = event.data?.to || [];
  if (!emailId) {
    await recordAudit("WEBHOOK_BAD_PAYLOAD", { reason: "email.received event did not contain data.email_id." });
    return NextResponse.json({ error: "Missing email_id" }, { status: 400 });
  }

  let messageId = null;
  for (const addr of toAddresses) {
    messageId = messageIdFromReplyAddress(addr);
    if (messageId) break;
  }

  if (!messageId) {
    await recordAudit("WEBHOOK_ADDRESS_NOT_RESOLVED", {
      reason: `None of the "to" addresses matched the arenewal+{messageId}@ pattern.`,
      to: toAddresses,
      emailId,
    });
    return NextResponse.json({ received: true, resolved: false });
  }

  const message = await getMessage(messageId);
  if (!message) {
    await recordAudit("WEBHOOK_MESSAGE_NOT_FOUND", {
      reason: `Parsed messageId "${messageId}" from the reply address, but no stored message has that ID.`,
      messageId,
      emailId,
    });
    return NextResponse.json({ received: true, resolved: false });
  }

  let fullEmail = { text: "", subject: event.data?.subject, from: event.data?.from };
  if (process.env.RESEND_API_KEY) {
    const { data, error } = await fetchReceivedEmail(emailId);
    if (error) {
      await recordAudit("WEBHOOK_RECEIVING_API_FAILED", {
        reason: `Receiving API failed: ${error?.message || JSON.stringify(error)}. Check that RESEND_API_KEY has sufficient access.`,
        messageId,
        emailId,
      });
    } else if (data) {
      fullEmail = data;
    }
  } else {
    await recordAudit("WEBHOOK_RECEIVING_API_SKIPPED", {
      reason: "RESEND_API_KEY is not set, so the reply body could not be fetched.",
      messageId,
      emailId,
    });
  }

  const result = await processReply({
    messageId,
    replyId: emailId,
    from: fullEmail.from || event.data?.from,
    subject: fullEmail.subject || event.data?.subject,
    plainText: fullEmail.text || "",
    receivedAt: event.created_at,
    rawSource: event,
    requestUrl: req.url,
  });

  if (result.error === "MESSAGE_NOT_FOUND") {
    return NextResponse.json({ received: true, resolved: false });
  }

  return NextResponse.json({
    received: true,
    resolved: true,
    duplicate: Boolean(result.duplicate),
    classification: result.classification?.classification ?? result.reply?.classification,
  });
}
