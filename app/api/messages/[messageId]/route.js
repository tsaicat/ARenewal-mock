import { NextResponse } from "next/server";
import { getMessage } from "@/lib/messages";
import { getRepliesForMessage } from "@/lib/replyProcessor";
import { getOfferState, getOfferHistory } from "@/lib/offers";

export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  const { messageId } = params;
  const message = await getMessage(messageId);
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const replies = await getRepliesForMessage(messageId);
  const offerState = await getOfferState(message.offerNumber);
  const offerHistory = await getOfferHistory(message.offerNumber);

  return NextResponse.json({ message, replies, offerState, offerHistory });
}
