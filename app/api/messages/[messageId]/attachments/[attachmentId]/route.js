import { NextResponse } from "next/server";
import { getAttachment } from "@/lib/attachments";
import { getMessage } from "@/lib/messages";
import { secureRead } from "@/lib/routeSecurity";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const access = await secureRead(req, "attachment", "READ_ATTACHMENT");
  if (!access.ok) return access.response;
  const { messageId, attachmentId } = params;
  const attachment = await getAttachment(attachmentId);
  if (!attachment || attachment.messageId !== messageId) {
    const message = await getMessage(messageId);
    const existed = Boolean(message?.attachments?.some((item) => item.attachmentId === attachmentId));
    return NextResponse.json(
      { error: existed ? "The retained QA copy of this attachment has been purged." : "Attachment not found", code: existed ? "ATTACHMENT_PURGED" : "ATTACHMENT_NOT_FOUND" },
      { status: existed ? 410 : 404 }
    );
  }

  await recordAudit("ATTACHMENT_ACCESSED", { messageId, attachmentId, principalType: access.principal?.type || "UNKNOWN" }).catch(() => {});
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
