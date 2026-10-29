import { NextResponse } from "next/server";
import { ATTACHMENT_LIMITS } from "@/lib/attachments";
import { securityDiagnostics } from "@/lib/security";
import { retentionDays } from "@/lib/environment";
import { RATE_LIMITS } from "@/lib/rateLimit";
import { persistentStorageConfigured } from "@/lib/store";

export const dynamic = "force-dynamic";
export async function GET() {
  const security = securityDiagnostics();
  return NextResponse.json({
    service: "mock-auto-renewal-email-api",
    serviceVersion: "0.6.1",
    nonPaymentCancellationNoticeSupported: true,
    verifiedCancellationDeliveryEvidenceSupported: true,
    // Support is code-level; this diagnostic says only whether the required
    // delivery-related environment settings are present, not whether Resend
    // has actually accepted or delivered a notice.
    cancellationDeliveryPrerequisitesConfigured: Boolean(persistentStorageConfigured && process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET && security.serviceAuthenticationConfigured),
    cancellationNoticePath: "/api/cancellation-notices",
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
