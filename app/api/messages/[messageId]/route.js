import { NextResponse } from "next/server";
import { getMessage } from "@/lib/messages";
import { getRepliesForMessage } from "@/lib/replyProcessor";
import { getOfferState, getOfferHistory, getOfferFamilyStates } from "@/lib/offers";
import { secureRead } from "@/lib/routeSecurity";
import { getAttachment } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const access = await secureRead(req, "read", "READ_MESSAGE");
  if (!access.ok) return access.response;
  const { messageId } = params;
  const message = await getMessage(messageId);
  if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  const [replies, offerState, offerHistory, family] = await Promise.all([
    getRepliesForMessage(messageId),
    getOfferState(message.offerNumber),
    getOfferHistory(message.offerNumber),
    getOfferFamilyStates(message.baseOfferNumber || message.offerNumber),
  ]);
  const attachmentAvailability = await Promise.all((message.attachments || []).map(async (attachment) => ({
    ...attachment,
    retentionStatus: (await getAttachment(attachment.attachmentId)) ? "AVAILABLE" : "PURGED",
  })));
  return NextResponse.json({
    message: { ...message, attachments: attachmentAvailability },
    replies, offerState, offerHistory, offerFamily: family
  });
}
