export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { Resend } from "resend";
import { messageIdFromReplyAddress } from "@/lib/resend";
import { processReply } from "@/lib/replyProcessor";
import { recordAudit } from "@/lib/audit";
import { getMessage } from "@/lib/messages";

const resend = new Resend(process.env.RESEND_API_KEY || "re_placeholder");

// POST /api/webhooks/resend
// Receives Resend's `email.received` inbound webhook. Webhook payloads
// only carry metadata, so the body is fetched separately via the
// Receiving API. See resend.com/docs/dashboard/webhooks/event-types.
export async function POST(req) {
  const rawBody = await req.text();

  let event;
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    try {
      event = resend.webhooks.verify({
        payload: rawBody,
        headers: {
          "svix-id": req.headers.get("svix-id"),
          "svix-timestamp": req.headers.get("svix-timestamp"),
          "svix-signature": req.headers.get("svix-signature"),
        },
        secret,
      });
    } catch (err) {
      await recordAudit("REPLY_DUPLICATE_IGNORED", { error: "Invalid webhook signature" });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // No RESEND_WEBHOOK_SECRET configured (local/dev use) — accept
    // unverified. Never do this in a real production deployment.
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const emailId = event.data.email_id;
  const toAddresses = event.data.to || [];

  // Recover which outbound message this is replying to via the
  // arenewal+{messageId}@iapasapp.com plus-address the offer email was
  // sent with.
  let messageId = null;
  for (const addr of toAddresses) {
    messageId = messageIdFromReplyAddress(addr);
    if (messageId) break;
  }

  if (!messageId) {
    await recordAudit("REPLY_DUPLICATE_IGNORED", {
      error: "Could not resolve messageId from inbound recipient address",
      to: toAddresses,
      emailId,
    });
    return NextResponse.json({ received: true, resolved: false });
  }

  const message = await getMessage(messageId);
  if (!message) {
    await recordAudit("REPLY_DUPLICATE_IGNORED", { error: "Unknown messageId", messageId, emailId });
    return NextResponse.json({ received: true, resolved: false });
  }

  // Fetch the full body (webhook payload is metadata-only).
  let fullEmail = { text: "", subject: event.data.subject, from: event.data.from };
  if (process.env.RESEND_API_KEY) {
    const { data, error } = await resend.emails.receiving.get(emailId);
    if (!error && data) fullEmail = data;
  }

  const result = await processReply({
    messageId,
    replyId: emailId,
    from: fullEmail.from || event.data.from,
    subject: fullEmail.subject || event.data.subject,
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
