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
//
// v0.2.2: every rejection path now logs a DISTINCT eventType with a
// human-readable `reason` field, instead of everything collapsing into
// a generic "REPLY_DUPLICATE_IGNORED" with no visible detail in the
// inbox UI's audit tab. If this webhook is failing, the audit log tab
// should now say exactly why in plain English.
// v0.2.3: fixed resend.webhooks.verify() call shape. The installed SDK
// (resend@6.x) expects { payload, headers: { id, timestamp, signature },
// webhookSecret } — NOT { payload, headers: {"svix-...": ...}, secret }.
// Passing the wrong shape doesn't throw a helpful error; it silently
// results in "Invalid signature" for every request, indistinguishable
// from an actually-wrong secret. If you're on a different resend
// version, re-check node_modules/resend/dist/index.cjs for the
// `verify(payload)` method under the Webhooks class before assuming
// your secret is wrong.
export async function POST(req) {
  const rawBody = await req.text();

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  let event;
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  if (secret) {
    try {
      event = resend.webhooks.verify({
        payload: rawBody,
        headers: {
          id: svixId,
          timestamp: svixTimestamp,
          signature: svixSignature,
        },
        webhookSecret: secret,
      });
    } catch (err) {
      await recordAudit("WEBHOOK_SIGNATURE_INVALID", {
        reason: `Signature check failed: ${err?.message || String(err)}`,
        hasSvixId: Boolean(svixId),
        hasSvixTimestamp: Boolean(svixTimestamp),
        hasSvixSignature: Boolean(svixSignature),
        secretPrefix: secret ? secret.slice(0, 10) : null,
        secretLength: secret ? secret.length : 0,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // No RESEND_WEBHOOK_SECRET configured (local/dev use) — accept
    // unverified. Never do this in a real production deployment.
    try {
      event = JSON.parse(rawBody);
    } catch {
      await recordAudit("WEBHOOK_BAD_PAYLOAD", { reason: "Body was not valid JSON and no secret was configured to verify it either way." });
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (event.type !== "email.received") {
    await recordAudit("WEBHOOK_EVENT_IGNORED", { reason: `Received event type "${event.type}", only email.received is handled.` });
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const emailId = event.data.email_id;
  const toAddresses = event.data.to || [];

  // Recover which outbound message this is replying to via the
  // arenewal+{messageId}@<domain> plus-address the offer email was sent
  // with.
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

  // Fetch the full body (webhook payload is metadata-only). This call
  // needs a Full-access RESEND_API_KEY — a Sending-only key will error
  // here. Previously this failure was swallowed silently and the reply
  // was processed with an empty body (misclassified as AMBIGUOUS); now
  // it's logged explicitly instead.
  let fullEmail = { text: "", subject: event.data.subject, from: event.data.from };
  if (process.env.RESEND_API_KEY) {
    const { data, error } = await resend.emails.receiving.get(emailId);
    if (error) {
      await recordAudit("WEBHOOK_RECEIVING_API_FAILED", {
        reason: `resend.emails.receiving.get() failed: ${error?.message || JSON.stringify(error)}. Check RESEND_API_KEY has Full access, not Sending-only.`,
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
