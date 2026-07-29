export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getMessage } from "@/lib/messages";
import { processReply } from "@/lib/replyProcessor";
import { newId } from "@/lib/ids";

// POST /api/renewal-emails/{messageId}/replies
// Submit a simulated customer reply (for testing without waiting on a
// real inbound email through Resend). Same classification + callback
// pipeline as the real Resend webhook uses.
export async function POST(req, { params }) {
  const { messageId } = params;

  const message = await getMessage(messageId);
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload.plainText || !payload.from) {
    return NextResponse.json({ error: "from and plainText are required" }, { status: 400 });
  }

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

  if (result.error === "MESSAGE_NOT_FOUND") {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  if (result.duplicate) {
    return NextResponse.json(
      {
        replyId,
        messageId,
        duplicate: true,
        classification: result.reply?.classification,
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      replyId,
      messageId,
      threadId: message.threadId,
      offerNumber: message.offerNumber,
      classification: result.classification.classification,
      confidence: result.classification.confidence,
      matchedPhrase: result.classification.matchedPhrase,
      callbackStatus: result.callback.result?.ok ? "APPLIED" : "PENDING",
      callbackEventId: result.callback.eventId,
    },
    { status: 201 }
  );
}
