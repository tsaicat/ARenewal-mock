import { NextResponse } from "next/server";
import { kvDelete, kvGet, kvSetIfAbsent } from "@/lib/store";
import { saveMessage, listMessages } from "@/lib/messages";
import { buildRenewalEmail } from "@/lib/templates";
import { sendRenewalEmail } from "@/lib/resend";
import { recordAudit } from "@/lib/audit";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "@/lib/privacy";
import { setOfferState } from "@/lib/offers";
import { newId } from "@/lib/ids";
import { arEmailKey } from "@/lib/keyspace";
import {
  AttachmentValidationError,
  attachmentRequestFingerprint,
  deleteAttachment,
  markAttachmentDelivery,
  prepareUploadedAttachments,
  storeAttachment,
} from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

function errorResponse(code, message, status = 400, detail = {}) {
  return NextResponse.json({ error: message, code, ...detail }, { status });
}

function resolvePackageCorrelation(payload = {}) {
  const nested = payload.formsPackage || {};
  const formsPackageId = String(payload.formsPackageId || nested.formsPackageId || nested.packageId || "").trim();
  const formsPackageSnapshotId = String(
    payload.formsPackageSnapshotId || nested.formsPackageSnapshotId || nested.formsSnapshotId || ""
  ).trim();
  return { formsPackageId, formsPackageSnapshotId };
}

function validatePackageCorrelation(payload = {}, hasAttachments = false) {
  const nested = payload.formsPackage || {};
  const topPackage = String(payload.formsPackageId || "").trim();
  const nestedPackage = String(nested.formsPackageId || nested.packageId || "").trim();
  const topSnapshot = String(payload.formsPackageSnapshotId || "").trim();
  const nestedSnapshot = String(nested.formsPackageSnapshotId || nested.formsSnapshotId || "").trim();

  if ((topPackage && nestedPackage && topPackage !== nestedPackage) || (topSnapshot && nestedSnapshot && topSnapshot !== nestedSnapshot)) {
    throw new AttachmentValidationError(
      "PACKAGE_SNAPSHOT_MISMATCH",
      "Forms package correlation values disagree between metadata fields.",
      409
    );
  }

  const correlation = resolvePackageCorrelation(payload);
  if (hasAttachments && (!correlation.formsPackageId || !correlation.formsPackageSnapshotId)) {
    throw new AttachmentValidationError(
      "PACKAGE_CORRELATION_MISSING",
      "formsPackageId and formsPackageSnapshotId are required when Forms attachments are supplied."
    );
  }
  return correlation;
}

async function parseRequest(req) {
  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await req.formData();
    } catch {
      throw new AttachmentValidationError("VALIDATION_FAILED", "Invalid multipart/form-data request.");
    }

    const metadataRaw = form.get("metadata") ?? form.get("payload");
    if (typeof metadataRaw !== "string" || !metadataRaw.trim()) {
      throw new AttachmentValidationError("VALIDATION_FAILED", "multipart/form-data requests require a JSON metadata field.");
    }

    let payload;
    try {
      payload = JSON.parse(metadataRaw);
    } catch {
      throw new AttachmentValidationError("VALIDATION_FAILED", "The multipart metadata field must contain valid JSON.");
    }

    const files = [];
    for (const [key, value] of form.entries()) {
      if ((key === "attachments" || key === "attachment") && value && typeof value.arrayBuffer === "function") {
        files.push(value);
      }
    }
    const attachments = await prepareUploadedAttachments(files);
    return { payload, attachments, requestMode: "multipart/form-data" };
  }

  if (contentType.includes("application/json") || !contentType) {
    let payload;
    try {
      payload = await req.json();
    } catch {
      throw new AttachmentValidationError("VALIDATION_FAILED", "Invalid JSON body.");
    }
    return { payload, attachments: [], requestMode: "application/json" };
  }

  throw new AttachmentValidationError(
    "UNSUPPORTED_CONTENT_TYPE",
    "Use application/json for email-only requests or multipart/form-data for email + Forms attachments.",
    415
  );
}

function milestoneCode(payload, numericMilestone) {
  const explicit = String(payload.noticeMilestone || payload.offer?.noticeMilestoneCode || "").trim().toUpperCase();
  if (["60_DAY", "45_DAY", "15_DAY"].includes(explicit)) return explicit;
  return [60, 45, 15].includes(Number(numericMilestone)) ? `${Number(numericMilestone)}_DAY` : "";
}

function apiResponseFromMessage(message, duplicate = false) {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    requestId: message.requestId,
    responseToken: message.responseToken || null,
    offerNumber: message.offerNumber,
    status: message.status,
    outcome: message.outcome || (message.status === "SENT" ? "EMAIL_SENT" : "EMAIL_FAILED"),
    emailDeliveryStatus: message.emailDeliveryStatus || message.status,
    acceptedAt: message.acceptedAt,
    deliveredAt: message.deliveredAt,
    milestone: message.milestone,
    noticeMilestone: message.noticeMilestone || null,
    subject: message.subject,
    integrationNamespace: message.integrationNamespace || "AR_EMAIL",
    formsDelivery: message.formsDelivery || { status: "NOT_REQUESTED", attachmentCount: 0, attachmentIds: [] },
    simulated: Boolean(message.resendSimulated),
    duplicate,
  };
}

// POST /api/renewal-emails
// application/json      -> existing email-only contract
// multipart/form-data   -> metadata JSON + actual generated Forms PDF(s)
export async function POST(req) {
  let parsed;
  try {
    parsed = await parseRequest(req);
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      return errorResponse(error.code, error.message, error.status, error.detail);
    }
    return errorResponse("VALIDATION_FAILED", "The request could not be parsed.", 400);
  }

  const { payload, attachments, requestMode } = parsed;
  const required = ["requestId", "offerNumber", "sourcePolicyId", "customerRef", "recipient"];
  const missing = required.filter((field) => !payload?.[field]);
  if (missing.length) return errorResponse("VALIDATION_FAILED", "Missing required fields", 400, { missing });
  if (!payload.recipient?.email) return errorResponse("VALIDATION_FAILED", "recipient.email is required", 400);

  let packageCorrelation;
  try {
    packageCorrelation = validatePackageCorrelation(payload, attachments.length > 0);
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      return errorResponse(error.code, error.message, error.status, error.detail);
    }
    throw error;
  }

  const requestSignature = {
    requestId: String(payload.requestId),
    offerNumber: String(payload.offerNumber),
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
    attachmentFingerprint: attachmentRequestFingerprint(attachments),
  };

  const idempotencyKey = arEmailKey("outbound-request", payload.requestId);
  const isFirst = await kvSetIfAbsent(idempotencyKey, { ...requestSignature, at: new Date().toISOString() });
  if (!isFirst) {
    const existingGuard = await kvGet(idempotencyKey);
    const sameRequest =
      existingGuard?.offerNumber === requestSignature.offerNumber &&
      String(existingGuard?.formsPackageSnapshotId || "") === requestSignature.formsPackageSnapshotId &&
      JSON.stringify(existingGuard?.attachmentFingerprint || []) === JSON.stringify(requestSignature.attachmentFingerprint);

    if (!sameRequest) {
      return errorResponse(
        "IDEMPOTENCY_CONFLICT",
        "requestId was already used for a different offer, Forms snapshot, or attachment payload.",
        409
      );
    }

    const priorMessageId = await kvGet(arEmailKey("outbound-request-result", payload.requestId));
    if (priorMessageId) {
      const { getMessage } = await import("@/lib/messages");
      const prior = await getMessage(priorMessageId);
      if (prior) return NextResponse.json(apiResponseFromMessage(prior, true), { status: 200 });
    }
    return errorResponse("REQUEST_IN_PROGRESS", "The original request is still being processed.", 409);
  }

  const privacyFieldsStripped = findPrivacyFieldsPresent(payload);
  const safePayload = stripPrivacyFields(payload);
  const messageId = newId("AR-EMAIL-MSG");
  const threadId = newId("AR-EMAIL-THREAD");
  const acceptedAt = new Date().toISOString();

  let storedAttachments = [];
  try {
    for (const attachment of attachments) {
      await recordAudit("FORMS_ATTACHMENT_RECEIVED", {
        messageId,
        offerNumber: safePayload.offerNumber,
        formsPackageId: packageCorrelation.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
      });
      const stored = await storeAttachment(attachment, {
        messageId,
        offerNumber: safePayload.offerNumber,
        ...packageCorrelation,
      });
      storedAttachments.push(stored);
      await recordAudit("FORMS_ATTACHMENT_STORED", {
        messageId,
        offerNumber: safePayload.offerNumber,
        formsPackageId: packageCorrelation.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
        attachmentId: stored.attachmentId,
        checksumSha256: stored.checksumSha256,
      });
    }
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((attachment) => deleteAttachment(attachment.attachmentId)));
    await kvDelete(idempotencyKey);
    await recordAudit("FORMS_DELIVERY_FAILED", {
      messageId,
      offerNumber: safePayload.offerNumber,
      formsPackageId: packageCorrelation.formsPackageId,
      formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
      error: error?.message || "Attachment storage failed",
    }).catch(() => {});
    return errorResponse("ATTACHMENT_STORAGE_FAILED", "The Forms attachment could not be persisted.", 500);
  }

  let subject = safePayload.subject;
  let html = safePayload.body?.html;
  let plainText = safePayload.body?.plainText;
  const built = buildRenewalEmail({
    sourcePolicyId: safePayload.sourcePolicyId,
    recipient: safePayload.recipient,
    offer: safePayload.offer || {},
  });
  let milestone = built.milestone;

  if (!html || !plainText) {
    subject = built.subject;
    html = built.html;
    plainText = built.plainText;
  } else {
    subject = subject || built.subject;
  }

  const noticeMilestone = milestoneCode(safePayload, milestone);
  const responseToken = String(
    safePayload.responseToken || safePayload.responseInstructions?.responseToken || ""
  ).trim() || null;

  const sendResult = await sendRenewalEmail({
    to: safePayload.recipient.email,
    subject,
    html,
    text: plainText,
    messageId,
    attachments,
    headers: {
      "X-Renewal-Offer-Number": safePayload.offerNumber,
      "X-Renewal-Message-Id": messageId,
      ...(packageCorrelation.formsPackageId ? { "X-Forms-Package-Id": packageCorrelation.formsPackageId } : {}),
      ...(packageCorrelation.formsPackageSnapshotId ? { "X-Forms-Package-Snapshot-Id": packageCorrelation.formsPackageSnapshotId } : {}),
    },
  });

  const status = sendResult.ok ? "SENT" : "FAILED";
  const deliveredAt = sendResult.ok ? new Date().toISOString() : null;
  const hasForms = attachments.length > 0;
  let formsEvidencePersisted = true;

  if (hasForms) {
    const markResults = await Promise.allSettled(
      storedAttachments.map((attachment) =>
        markAttachmentDelivery(
          attachment.attachmentId,
          sendResult.ok ? "DELIVERED" : "DELIVERY_FAILED",
          deliveredAt
        )
      )
    );

    formsEvidencePersisted = markResults.every((result) => result.status === "fulfilled" && Boolean(result.value));
    storedAttachments = markResults.map((result, index) =>
      result.status === "fulfilled" && result.value ? result.value : storedAttachments[index]
    );

    if (!formsEvidencePersisted) {
      await recordAudit("FORMS_DELIVERY_EVIDENCE_FAILED", {
        messageId,
        offerNumber: safePayload.offerNumber,
        formsPackageId: packageCorrelation.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
        reason: "Attachment delivery evidence could not be fully persisted.",
      }).catch(() => {});
    }
  }

  const formsStatus = !hasForms
    ? "NOT_REQUESTED"
    : (sendResult.ok && formsEvidencePersisted ? "DELIVERED" : "FAILED");

  const outcome = sendResult.ok
    ? (!hasForms ? "EMAIL_SENT" : (formsStatus === "DELIVERED" ? "EMAIL_SENT_FORMS_DELIVERED" : "EMAIL_SENT_FORMS_FAILED"))
    : "EMAIL_FAILED";

  const formsDelivery = {
    status: formsStatus,
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachmentIds: storedAttachments.map((attachment) => attachment.attachmentId),
    attachmentCount: storedAttachments.length,
    deliveredAt: formsStatus === "DELIVERED" ? deliveredAt : null,
  };

  const message = {
    messageId,
    threadId,
    requestId: safePayload.requestId,
    responseToken,
    requestMode,
    messageType: safePayload.messageType || "AUTO_RENEWAL_OFFER",
    integrationNamespace: safePayload.integrationNamespace || "AR_EMAIL",
    offerNumber: safePayload.offerNumber,
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    recipient: safePayload.recipient,
    subject,
    body: { plainText, html },
    offer: safePayload.offer || {},
    milestone,
    noticeMilestone,
    responseInstructions: safePayload.responseInstructions || {},
    callback: safePayload.callback || {},
    sentBy: safePayload.sentBy || {},
    createdAt: safePayload.createdAt || acceptedAt,
    status,
    outcome,
    emailDeliveryStatus: status,
    acceptedAt,
    deliveredAt,
    resendId: sendResult.id || null,
    resendSimulated: Boolean(sendResult.simulated),
    resendError: sendResult.ok ? null : sendResult.error,
    privacyFieldsStripped,
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachments: storedAttachments,
    formsDelivery,
  };

  await saveMessage(message);
  await kvSetIfAbsent(arEmailKey("outbound-request-result", payload.requestId), messageId);

  await setOfferState(safePayload.offerNumber, {
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    currentFormsPackageId: packageCorrelation.formsPackageId || "",
    currentFormsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || "",
    customerResponseStatus: "Pending",
    emailGateway: {
      messageId,
      threadId,
      requestId: safePayload.requestId,
      responseToken: responseToken || "",
      noticeMilestone,
      deliveryStatus: status,
      deliveryAcceptedAt: acceptedAt,
      deliveredAt: deliveredAt || "",
      formsDeliveryStatus: formsStatus,
      formsPackageId: packageCorrelation.formsPackageId || "",
      formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || "",
    },
  });

  await recordAudit("MESSAGE_SENT", {
    messageId,
    offerNumber: safePayload.offerNumber,
    requestId: safePayload.requestId,
    milestone,
    noticeMilestone,
    status,
    outcome,
    privacyFieldsStripped,
    simulated: Boolean(sendResult.simulated),
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachmentCount: storedAttachments.length,
  });

  if (hasForms) {
    await recordAudit(sendResult.ok ? "FORMS_DELIVERED" : "FORMS_DELIVERY_FAILED", {
      messageId,
      offerNumber: safePayload.offerNumber,
      requestId: safePayload.requestId,
      formsPackageId: packageCorrelation.formsPackageId,
      formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
      attachmentIds: storedAttachments.map((attachment) => attachment.attachmentId),
      status: formsStatus,
      error: formsStatus === "DELIVERED" ? undefined : (sendResult.ok ? "Delivery evidence persistence failed" : JSON.stringify(sendResult.error || {})),
    });
  }

  return NextResponse.json(apiResponseFromMessage(message, false), { status: sendResult.ok ? 201 : 502 });
}

// GET /api/renewal-emails — list stored messages (for the inbox UI).
export async function GET() {
  const messages = await listMessages(200);
  return NextResponse.json({ messages });
}
