// lib/attachments.js
//
// Auto-Renewal Forms attachment validation + persistence.
// The mock stores the actual file content (Base64 encoded) in the same
// persistent backend as the email register, while message records only keep
// safe metadata. This keeps attachments available for the lifetime of the
// stored mock message without placing raw binary in inbox/API JSON responses.

import { createHash } from "crypto";
import { kvDelete, kvGet, kvSet } from "./store.js";
import { arEmailKey } from "./keyspace.js";
import { newId } from "./ids.js";
import { retentionExpiry, ttlSecondsUntil } from "./retention.js";

export const ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 3,
  maxBytesPerFile: 3 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024,
  allowedContentTypes: Object.freeze(["application/pdf"]),
});

const ATTACHMENT_KEY = (attachmentId) => arEmailKey("attachment", attachmentId);

export class AttachmentValidationError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message);
    this.name = "AttachmentValidationError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function sanitizeAttachmentFileName(value = "renewal-forms.pdf") {
  const base = String(value || "renewal-forms.pdf")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  return base || "renewal-forms.pdf";
}

function looksLikePdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function prepareUploadedAttachments(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new AttachmentValidationError("ATTACHMENT_REQUIRED", "At least one Forms attachment is required.");
  }
  if (files.length > ATTACHMENT_LIMITS.maxCount) {
    throw new AttachmentValidationError(
      "ATTACHMENT_COUNT_EXCEEDED",
      `A maximum of ${ATTACHMENT_LIMITS.maxCount} attachments is supported.`,
      400,
      { maxAttachmentCount: ATTACHMENT_LIMITS.maxCount }
    );
  }

  const prepared = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new AttachmentValidationError("ATTACHMENT_REQUIRED", "A valid uploaded file is required.");
    }

    const fileName = sanitizeAttachmentFileName(file.name);
    const contentType = String(file.type || "").toLowerCase();
    const bytes = Buffer.from(await file.arrayBuffer());
    const sizeBytes = bytes.length;

    if (sizeBytes === 0) {
      throw new AttachmentValidationError("ATTACHMENT_REQUIRED", `${fileName} is empty.`);
    }
    if (sizeBytes > ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new AttachmentValidationError(
        "ATTACHMENT_TOO_LARGE",
        `${fileName} exceeds the ${ATTACHMENT_LIMITS.maxBytesPerFile} byte per-file limit.`,
        413,
        { fileName, sizeBytes, maxBytesPerFile: ATTACHMENT_LIMITS.maxBytesPerFile }
      );
    }
    totalBytes += sizeBytes;
    if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new AttachmentValidationError(
        "ATTACHMENT_TOO_LARGE",
        `The attachment set exceeds the ${ATTACHMENT_LIMITS.maxTotalBytes} byte total limit.`,
        413,
        { totalBytes, maxTotalBytes: ATTACHMENT_LIMITS.maxTotalBytes }
      );
    }
    if (!ATTACHMENT_LIMITS.allowedContentTypes.includes(contentType) || !looksLikePdf(bytes)) {
      throw new AttachmentValidationError(
        "UNSUPPORTED_ATTACHMENT_TYPE",
        `${fileName} must be a valid PDF (application/pdf).`,
        415,
        { fileName, contentType }
      );
    }

    prepared.push({
      attachmentId: newId("AR-EMAIL-ATTACHMENT"),
      fileName,
      contentType: "application/pdf",
      sizeBytes,
      checksumSha256: checksum(bytes),
      contentBase64: bytes.toString("base64"),
    });
  }

  return prepared;
}

export function attachmentRequestFingerprint(prepared = []) {
  return prepared.map((file) => ({
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
  }));
}

export async function storeAttachment(file, correlation) {
  const uploadedAt = new Date().toISOString();
  const record = {
    attachmentId: file.attachmentId,
    messageId: correlation.messageId,
    offerNumber: correlation.offerNumber,
    formsPackageId: correlation.formsPackageId,
    formsPackageSnapshotId: correlation.formsPackageSnapshotId,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    uploadedAt,
    deliveryStatus: "STORED",
    deliveredAt: null,
    contentBase64: file.contentBase64,
    retentionExpiresAt: retentionExpiry(new Date(uploadedAt)),
  };
  await kvSet(ATTACHMENT_KEY(file.attachmentId), record, { ttlSeconds: ttlSecondsUntil(record.retentionExpiresAt) });
  return attachmentMetadata(record);
}

export async function markAttachmentDelivery(attachmentId, deliveryStatus, deliveredAt = null) {
  const existing = await kvGet(ATTACHMENT_KEY(attachmentId));
  if (!existing) return null;
  const updated = {
    ...existing,
    deliveryStatus,
    deliveredAt: deliveredAt || null,
  };
  await kvSet(ATTACHMENT_KEY(attachmentId), updated, { ttlSeconds: ttlSecondsUntil(updated.retentionExpiresAt) });
  return attachmentMetadata(updated);
}

export async function deleteAttachment(attachmentId) {
  await kvDelete(ATTACHMENT_KEY(attachmentId));
}

export async function getAttachment(attachmentId) {
  return kvGet(ATTACHMENT_KEY(attachmentId));
}

export function attachmentMetadata(record = {}) {
  return {
    attachmentId: record.attachmentId,
    messageId: record.messageId,
    offerNumber: record.offerNumber,
    formsPackageId: record.formsPackageId,
    formsPackageSnapshotId: record.formsPackageSnapshotId,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    uploadedAt: record.uploadedAt,
    deliveryStatus: record.deliveryStatus,
    deliveredAt: record.deliveredAt || null,
    retentionExpiresAt: record.retentionExpiresAt || null,
  };
}
