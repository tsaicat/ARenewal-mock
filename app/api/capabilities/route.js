import { NextResponse } from "next/server";
import { ATTACHMENT_LIMITS } from "@/lib/attachments";
import { securityDiagnostics } from "@/lib/security";
import { retentionDays } from "@/lib/environment";
import { RATE_LIMITS } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export async function GET() {
  const security = securityDiagnostics();
  return NextResponse.json({
    service: "mock-auto-renewal-email-api",
    serviceVersion: "0.5.0",
    emailOnlyJsonSupported: true,
    multipartSupported: true,
    attachmentDeliverySupported: true,
    supportedAttachmentTypes: [...ATTACHMENT_LIMITS.allowedContentTypes],
    maxAttachmentBytes: ATTACHMENT_LIMITS.maxBytesPerFile,
    maxAttachmentTotalBytes: ATTACHMENT_LIMITS.maxTotalBytes,
    maxAttachmentCount: ATTACHMENT_LIMITS.maxCount,
    responseHistorySupported: true,
    responseEventIdSupported: true,
    offerRevisionLineageSupported: true,
    acknowledgmentDeliverySupported: true,
    trueDeliveryWebhookSupported: true,
    controlledResendSupported: true,
    semanticMilestoneIdempotencySupported: true,
    authenticationRequired: security.authenticationRequired,
    qaAuthenticationRequired: security.qaAuthenticationRequired,
    retentionDays: retentionDays(),
    rateLimits: {
      sendPerMinute: RATE_LIMITS.send.limit,
      acknowledgmentPerMinute: RATE_LIMITS.acknowledgment.limit,
      qaReplyPerMinute: RATE_LIMITS.reply.limit,
    },
  });
}
