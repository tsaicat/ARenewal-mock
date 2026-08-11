import { NextResponse } from "next/server";
import { kvDelete, kvGet, kvSetIfAbsent } from "@/lib/store";
import { saveMessage, listMessages, getMessage, updateMessage } from "@/lib/messages";
import { buildRenewalEmail } from "@/lib/templates";
import { sendRenewalEmail } from "@/lib/resend";
import { recordAudit } from "@/lib/audit";
import { stripPrivacyFields, findPrivacyFieldsPresent } from "@/lib/privacy";
import { getOfferState, normalizeOfferLineage, registerOfferRevision, setOfferState } from "@/lib/offers";
import { newId } from "@/lib/ids";
import { arEmailKey } from "@/lib/keyspace";
import {
  reserveNormalCommunication,
  completeNormalCommunication,
  releaseNormalCommunication,
} from "@/lib/communications";
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
  return {
    formsPackageId: String(payload.formsPackageId || nested.formsPackageId || nested.packageId || "").trim(),
    formsPackageSnapshotId: String(payload.formsPackageSnapshotId || nested.formsPackageSnapshotId || nested.formsSnapshotId || "").trim(),
  };
}

function validatePackageCorrelation(payload = {}, hasAttachments = false) {
  const nested = payload.formsPackage || {};
  const topPackage = String(payload.formsPackageId || "").trim();
  const nestedPackage = String(nested.formsPackageId || nested.packageId || "").trim();
  const topSnapshot = String(payload.formsPackageSnapshotId || "").trim();
  const nestedSnapshot = String(nested.formsPackageSnapshotId || nested.formsSnapshotId || "").trim();

  if ((topPackage && nestedPackage && topPackage !== nestedPackage) || (topSnapshot && nestedSnapshot && topSnapshot !== nestedSnapshot)) {
    throw new AttachmentValidationError("PACKAGE_SNAPSHOT_MISMATCH", "Forms package correlation values disagree between metadata fields.", 409);
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
      if ((key === "attachments" || key === "attachment") && value && typeof value.arrayBuffer === "function") files.push(value);
    }
    const attachments = files.length ? await prepareUploadedAttachments(files) : [];
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

function apiResponseFromMessage(message, duplicate = false, semanticDuplicate = false) {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    requestId: message.requestId,
    responseToken: message.responseToken || null,
    offerNumber: message.offerNumber,
    baseOfferNumber: message.baseOfferNumber || message.offerNumber,
    offerVersion: message.offerVersion || 1,
    supersedesOfferNumber: message.supersedesOfferNumber || null,
    offerStatus: message.offerStatus || "CURRENT",
    status: message.status,
    outcome: message.outcome || (message.status === "SENT" ? "EMAIL_SENT" : "EMAIL_FAILED"),
    emailDeliveryStatus: message.emailDeliveryStatus || message.status,
    deliveryMode: message.deliveryMode || (message.resendSimulated ? "SIMULATED" : "REAL_PROVIDER"),
    providerMessageId: message.providerMessageId || null,
    providerDelivery: message.providerDelivery || null,
    acceptedAt: message.acceptedAt || null,
    deliveredAt: message.deliveredAt || null,
    milestone: message.milestone,
    noticeMilestone: message.noticeMilestone || null,
    communicationType: message.communicationType || null,
    subject: message.subject,
    integrationNamespace: message.integrationNamespace || "AR_EMAIL",
    formsDelivery: message.formsDelivery || { status: "NOT_REQUESTED", attachmentCount: 0, attachmentIds: [] },
    simulated: Boolean(message.resendSimulated),
    providerError: message.resendError || null,
    resend: Boolean(message.resendOfMessageId),
    resendOfMessageId: message.resendOfMessageId || null,
    duplicate,
    semanticDuplicate,
  };
}

export async function POST(req) {
  let parsed;
  try {
    parsed = await parseRequest(req);
  } catch (error) {
    if (error instanceof AttachmentValidationError) return errorResponse(error.code, error.message, error.status, error.detail);
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
    if (error instanceof AttachmentValidationError) return errorResponse(error.code, error.message, error.status, error.detail);
    throw error;
  }

  const isResend = payload.resend === true;
  let originalMessage = null;
  if (isResend) {
    if (!payload.originalMessageId || !String(payload.resendReason || "").trim() || !payload.resendActor) {
      return errorResponse("RESEND_PROVENANCE_REQUIRED", "Controlled resend requires originalMessageId, resendReason, and resendActor.", 400);
    }
    originalMessage = await getMessage(payload.originalMessageId);
    if (!originalMessage) return errorResponse("ORIGINAL_MESSAGE_NOT_FOUND", "The original message for controlled resend was not found.", 404);
    if (originalMessage.offerNumber !== payload.offerNumber) {
      return errorResponse("RESEND_CORRELATION_MISMATCH", "Controlled resend must preserve the original offer correlation.", 409);
    }
    if (originalMessage.attachments?.length && attachments.length === 0) {
      return errorResponse("RESEND_ATTACHMENT_REQUIRED", "A controlled resend of a Forms message must include the actual Forms attachment again.", 400);
    }
    if (originalMessage.formsPackageId) {
      if (packageCorrelation.formsPackageId && packageCorrelation.formsPackageId !== originalMessage.formsPackageId) {
        return errorResponse("RESEND_CORRELATION_MISMATCH", "Controlled resend must preserve formsPackageId.", 409);
      }
      if (packageCorrelation.formsPackageSnapshotId && packageCorrelation.formsPackageSnapshotId !== originalMessage.formsPackageSnapshotId) {
        return errorResponse("RESEND_CORRELATION_MISMATCH", "Controlled resend must preserve formsPackageSnapshotId.", 409);
      }
      packageCorrelation = {
        formsPackageId: packageCorrelation.formsPackageId || originalMessage.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || originalMessage.formsPackageSnapshotId,
      };
    }
  }

  const requestSignature = {
    requestId: String(payload.requestId),
    offerNumber: String(payload.offerNumber),
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
    attachmentFingerprint: attachmentRequestFingerprint(attachments),
    resendOfMessageId: isResend ? payload.originalMessageId : null,
  };

  const idempotencyKey = arEmailKey("outbound-request", payload.requestId);
  const isFirst = await kvSetIfAbsent(idempotencyKey, { ...requestSignature, at: new Date().toISOString() });
  if (!isFirst) {
    const existingGuard = await kvGet(idempotencyKey);
    const sameRequest =
      existingGuard?.offerNumber === requestSignature.offerNumber &&
      String(existingGuard?.formsPackageSnapshotId || "") === requestSignature.formsPackageSnapshotId &&
      String(existingGuard?.resendOfMessageId || "") === String(requestSignature.resendOfMessageId || "") &&
      JSON.stringify(existingGuard?.attachmentFingerprint || []) === JSON.stringify(requestSignature.attachmentFingerprint);
    if (!sameRequest) {
      return errorResponse("IDEMPOTENCY_CONFLICT", "requestId was already used for a different offer, Forms snapshot, resend, or attachment payload.", 409);
    }
    const priorMessageId = await kvGet(arEmailKey("outbound-request-result", payload.requestId));
    if (priorMessageId) {
      const prior = await getMessage(priorMessageId);
      if (prior) return NextResponse.json(apiResponseFromMessage(prior, true, false), { status: 200 });
    }
    return errorResponse("REQUEST_IN_PROGRESS", "The original request is still being processed.", 409);
  }

  const privacyFieldsStripped = findPrivacyFieldsPresent(payload);
  const safePayload = stripPrivacyFields(payload);
  const lineage = normalizeOfferLineage(safePayload);
  const built = buildRenewalEmail({ sourcePolicyId: safePayload.sourcePolicyId, recipient: safePayload.recipient, offer: safePayload.offer || {} });
  const milestone = built.milestone;
  const noticeMilestone = milestoneCode(safePayload, milestone);
  const communicationType = String(safePayload.communicationType || (attachments.length ? "FORMS" : "NOTICE")).trim().toUpperCase();

  let semanticReservation = { reserved: true, key: null, record: null };
  if (!isResend && noticeMilestone) {
    semanticReservation = await reserveNormalCommunication(
      {
        baseOfferNumber: lineage.baseOfferNumber,
        offerVersion: lineage.offerVersion,
        noticeMilestone,
        communicationType,
      },
      safePayload.requestId
    );
    if (!semanticReservation.reserved) {
      const priorMessageId = semanticReservation.record?.messageId;
      if (priorMessageId) {
        const prior = await getMessage(priorMessageId);
        if (prior) {
          await kvSetIfAbsent(arEmailKey("outbound-request-result", payload.requestId), priorMessageId);
          return NextResponse.json(apiResponseFromMessage(prior, false, true), { status: 200 });
        }
      }
      await kvDelete(idempotencyKey);
      return errorResponse("COMMUNICATION_IN_PROGRESS", "The same normal offer-version milestone communication is already being processed.", 409);
    }
  }

  if (lineage.supersedesOfferNumber) {
    const priorOffer = await getOfferState(lineage.supersedesOfferNumber);
    if (priorOffer.offerStatus !== "SUPERSEDED" || priorOffer.supersededByOfferNumber !== lineage.offerNumber) {
      await recordAudit("OFFER_SUPERSEDED", {
        baseOfferNumber: lineage.baseOfferNumber,
        supersededOfferNumber: lineage.supersedesOfferNumber,
        supersededByOfferNumber: lineage.offerNumber,
        offerVersion: lineage.offerVersion,
      });
    }
  }

  await registerOfferRevision(lineage, {
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    ...(packageCorrelation.formsPackageId ? { currentFormsPackageId: packageCorrelation.formsPackageId } : {}),
    ...(packageCorrelation.formsPackageSnapshotId ? { currentFormsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId } : {}),
  });

  const messageId = newId("AR-EMAIL-MSG");
  const threadId = originalMessage?.threadId || newId("AR-EMAIL-THREAD");
  const requestAcceptedAt = new Date().toISOString();
  let storedAttachments = [];

  try {
    for (const attachment of attachments) {
      await recordAudit("FORMS_ATTACHMENT_RECEIVED", {
        messageId,
        offerNumber: safePayload.offerNumber,
        baseOfferNumber: lineage.baseOfferNumber,
        offerVersion: lineage.offerVersion,
        formsPackageId: packageCorrelation.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
      });
      const stored = await storeAttachment(attachment, { messageId, offerNumber: safePayload.offerNumber, ...packageCorrelation });
      storedAttachments.push(stored);
      await recordAudit("FORMS_ATTACHMENT_STORED", {
        messageId,
        offerNumber: safePayload.offerNumber,
        attachmentId: stored.attachmentId,
        checksumSha256: stored.checksumSha256,
      });
    }
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((attachment) => deleteAttachment(attachment.attachmentId)));
    await kvDelete(idempotencyKey);
    await releaseNormalCommunication(semanticReservation.key);
    await recordAudit("FORMS_DELIVERY_FAILED", { messageId, offerNumber: safePayload.offerNumber, error: error?.message || "Attachment storage failed" }).catch(() => {});
    return errorResponse("ATTACHMENT_STORAGE_FAILED", "The Forms attachment could not be persisted.", 500);
  }

  let subject = safePayload.subject;
  let html = safePayload.body?.html;
  let plainText = safePayload.body?.plainText;
  if (!html || !plainText) {
    subject = built.subject;
    html = built.html;
    plainText = built.plainText;
  } else {
    subject = subject || built.subject;
  }

  const responseToken = String(safePayload.responseToken || safePayload.responseInstructions?.responseToken || "").trim() || null;
  const sendResult = await sendRenewalEmail({
    to: safePayload.recipient.email,
    subject,
    html,
    text: plainText,
    messageId,
    attachments,
    headers: {
      "X-Renewal-Offer-Number": safePayload.offerNumber,
      "X-Renewal-Base-Offer-Number": lineage.baseOfferNumber,
      "X-Renewal-Offer-Version": String(lineage.offerVersion),
      "X-Renewal-Message-Id": messageId,
      ...(packageCorrelation.formsPackageId ? { "X-Forms-Package-Id": packageCorrelation.formsPackageId } : {}),
      ...(packageCorrelation.formsPackageSnapshotId ? { "X-Forms-Package-Snapshot-Id": packageCorrelation.formsPackageSnapshotId } : {}),
    },
  });

  const hasForms = attachments.length > 0;
  const status = sendResult.ok ? "SENT" : "FAILED";
  const deliveryMode = sendResult.deliveryMode || (sendResult.simulated ? "SIMULATED" : "REAL_PROVIDER");
  const emailDeliveryStatus = !sendResult.ok ? "FAILED" : sendResult.simulated ? "SIMULATED" : "DELIVERY_PENDING";
  const attachmentDeliveryStatus = !sendResult.ok ? "DELIVERY_FAILED" : sendResult.simulated ? "SIMULATED" : "DELIVERY_PENDING";
  let formsEvidencePersisted = true;

  if (hasForms) {
    const markResults = await Promise.allSettled(
      storedAttachments.map((attachment) => markAttachmentDelivery(attachment.attachmentId, attachmentDeliveryStatus, null))
    );
    formsEvidencePersisted = markResults.every((result) => result.status === "fulfilled" && Boolean(result.value));
    storedAttachments = markResults.map((result, index) => (result.status === "fulfilled" && result.value ? result.value : storedAttachments[index]));
    if (!formsEvidencePersisted) {
      await recordAudit("FORMS_DELIVERY_EVIDENCE_FAILED", { messageId, offerNumber: safePayload.offerNumber, reason: "Attachment delivery evidence could not be fully persisted." }).catch(() => {});
    }
  }

  const formsStatus = !hasForms
    ? "NOT_REQUESTED"
    : !sendResult.ok || !formsEvidencePersisted
      ? "FAILED"
      : sendResult.simulated
        ? "SIMULATED"
        : "DELIVERY_PENDING";
  const outcome = !sendResult.ok
    ? "EMAIL_FAILED"
    : sendResult.simulated
      ? (hasForms ? "EMAIL_SIMULATED_FORMS_SIMULATED" : "EMAIL_SIMULATED")
      : (hasForms ? "EMAIL_SENT_FORMS_PENDING" : "EMAIL_SENT_DELIVERY_PENDING");

  const formsDelivery = {
    status: formsStatus,
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachmentIds: storedAttachments.map((attachment) => attachment.attachmentId),
    attachmentCount: storedAttachments.length,
    deliveredAt: null,
  };

  const message = {
    messageId,
    threadId,
    requestId: safePayload.requestId,
    responseToken,
    requestMode,
    messageType: safePayload.messageType || "AUTO_RENEWAL_OFFER",
    communicationType,
    integrationNamespace: safePayload.integrationNamespace || "AR_EMAIL",
    offerNumber: safePayload.offerNumber,
    baseOfferNumber: lineage.baseOfferNumber,
    offerVersion: lineage.offerVersion,
    supersedesOfferNumber: lineage.supersedesOfferNumber,
    offerStatus: "CURRENT",
    offerExpirationDate: lineage.offerExpirationDate,
    responseDueDate: lineage.responseDueDate,
    renewalEffectiveDate: lineage.renewalEffectiveDate,
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
    createdAt: safePayload.createdAt || requestAcceptedAt,
    status,
    outcome,
    emailDeliveryStatus,
    deliveryMode,
    acceptedAt: sendResult.ok ? new Date().toISOString() : null,
    deliveredAt: null,
    providerMessageId: sendResult.ok && !sendResult.simulated ? sendResult.id || null : null,
    providerDelivery: {
      provider: "RESEND",
      providerMessageId: sendResult.ok && !sendResult.simulated ? sendResult.id || null : null,
      providerEventId: null,
      providerEventType: null,
      providerEventReceivedAt: null,
      providerDeliveryStatus: emailDeliveryStatus,
    },
    resendId: sendResult.id || null,
    resendSimulated: Boolean(sendResult.simulated),
    resendError: sendResult.ok ? null : sendResult.error,
    resendOfMessageId: originalMessage?.messageId || null,
    resendReason: isResend ? String(safePayload.resendReason || "").trim() : null,
    resendActor: isResend ? safePayload.resendActor : null,
    privacyFieldsStripped,
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachments: storedAttachments,
    formsDelivery,
  };

  await saveMessage(message);
  await kvSetIfAbsent(arEmailKey("outbound-request-result", payload.requestId), messageId);

  if (sendResult.ok) {
    await completeNormalCommunication(semanticReservation.key, { messageId, requestId: safePayload.requestId });
  } else {
    await releaseNormalCommunication(semanticReservation.key);
  }

  if (isResend && originalMessage) {
    await updateMessage(originalMessage.messageId, {
      resendCount: Number(originalMessage.resendCount || 0) + 1,
      lastResentAt: new Date().toISOString(),
    });
    await recordAudit("CONTROLLED_RESEND", {
      originalMessageId: originalMessage.messageId,
      messageId,
      offerNumber: safePayload.offerNumber,
      baseOfferNumber: lineage.baseOfferNumber,
      offerVersion: lineage.offerVersion,
      resendReason: message.resendReason,
      resendActor: message.resendActor,
    });
  }

  await setOfferState(safePayload.offerNumber, {
    sourcePolicyId: safePayload.sourcePolicyId,
    resultingPolicyId: safePayload.resultingPolicyId,
    customerRef: safePayload.customerRef,
    baseOfferNumber: lineage.baseOfferNumber,
    offerVersion: lineage.offerVersion,
    ...(packageCorrelation.formsPackageId ? { currentFormsPackageId: packageCorrelation.formsPackageId } : {}),
    ...(packageCorrelation.formsPackageSnapshotId ? { currentFormsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId } : {}),
    emailGateway: {
      messageId,
      threadId,
      requestId: safePayload.requestId,
      responseToken: responseToken || "",
      noticeMilestone,
      communicationType,
      deliveryStatus: emailDeliveryStatus,
      deliveryAcceptedAt: message.acceptedAt || "",
      deliveredAt: "",
      formsDeliveryStatus: formsStatus,
      formsPackageId: packageCorrelation.formsPackageId || "",
      formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || "",
      providerMessageId: message.providerMessageId || "",
    },
  });

  await recordAudit(sendResult.ok ? "PROVIDER_SEND_ACCEPTED" : "EMAIL_SEND_FAILED", {
    messageId,
    offerNumber: safePayload.offerNumber,
    baseOfferNumber: lineage.baseOfferNumber,
    offerVersion: lineage.offerVersion,
    requestId: safePayload.requestId,
    milestone,
    noticeMilestone,
    communicationType,
    status,
    emailDeliveryStatus,
    outcome,
    privacyFieldsStripped,
    simulated: Boolean(sendResult.simulated),
    providerMessageId: message.providerMessageId,
    formsPackageId: packageCorrelation.formsPackageId || null,
    formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId || null,
    attachmentCount: storedAttachments.length,
  });

  if (hasForms) {
    await recordAudit(
      formsStatus === "FAILED" ? "FORMS_DELIVERY_FAILED" : formsStatus === "SIMULATED" ? "FORMS_DELIVERY_SIMULATED" : "FORMS_DELIVERY_PENDING",
      {
        messageId,
        offerNumber: safePayload.offerNumber,
        formsPackageId: packageCorrelation.formsPackageId,
        formsPackageSnapshotId: packageCorrelation.formsPackageSnapshotId,
        attachmentIds: storedAttachments.map((attachment) => attachment.attachmentId),
        status: formsStatus,
      }
    );
  }

  return NextResponse.json(apiResponseFromMessage(message, false, false), { status: sendResult.ok ? 201 : 502 });
}

export async function GET() {
  const messages = await listMessages(200);
  return NextResponse.json({ messages });
}
