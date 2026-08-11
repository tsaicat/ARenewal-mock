import { NextResponse } from "next/server";
import { getAttachment } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const { messageId, attachmentId } = params;
  const attachment = await getAttachment(attachmentId);
  if (!attachment || attachment.messageId !== messageId) {
    return NextResponse.json({ error: "Attachment not found", code: "ATTACHMENT_NOT_FOUND" }, { status: 404 });
  }

  const bytes = Buffer.from(attachment.contentBase64, "base64");
  const disposition = new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  const safeName = String(attachment.fileName || "renewal-forms.pdf").replace(/["\r\n]/g, "_");

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": attachment.contentType || "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
