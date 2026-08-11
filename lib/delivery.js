import { kvDelete, kvGet, kvSet, kvSetIfAbsent } from "./store.js";
import { arEmailKey } from "./keyspace.js";
import { getMessageByProviderId, updateMessage } from "./messages.js";
import { markAttachmentDelivery } from "./attachments.js";
import { setOfferState } from "./offers.js";
import { recordAudit } from "./audit.js";

const PROVIDER_EVENT_RESULT_KEY = (id) => arEmailKey("provider-event-result", id);
const PROVIDER_EVENT_SEEN_KEY = (id) => arEmailKey("provider-event-seen", id);

const STATUS_MAP = {
  "email.sent": { email: "DELIVERY_PENDING", forms: "DELIVERY_PENDING", attachment: "DELIVERY_PENDING", audit: "PROVIDER_SEND_ACCEPTED" },
  "email.delivered": { email: "DELIVERED", forms: "DELIVERED", attachment: "DELIVERED", audit: "EMAIL_DELIVERED" },
  "email.delivery_delayed": { email: "DELIVERY_DELAYED", forms: "DELIVERY_PENDING", attachment: "DELIVERY_PENDING", audit: "EMAIL_DELIVERY_DELAYED" },
  "email.bounced": { email: "BOUNCED", forms: "FAILED", attachment: "DELIVERY_FAILED", audit: "EMAIL_BOUNCED" },
  "email.failed": { email: "FAILED", forms: "FAILED", attachment: "DELIVERY_FAILED", audit: "EMAIL_FAILED" },
};

export function providerEventIdentity({ svixId, event }) {
  return String(
    svixId ||
      event?.id ||
      `${event?.type || "unknown"}:${event?.data?.email_id || "unknown"}:${event?.created_at || event?.data?.created_at || "unknown"}`
  );
}

export function isOutboundDeliveryEvent(type) {
  return Boolean(STATUS_MAP[type]);
}

export async function applyProviderDeliveryEvent({ event, providerEventId }) {
  const mapping = STATUS_MAP[event.type];
  if (!mapping) return { ignored: true, reason: "UNSUPPORTED_DELIVERY_EVENT" };

  const dedupeKey = PROVIDER_EVENT_SEEN_KEY(providerEventId);
  const first = await kvSetIfAbsent(dedupeKey, {
    providerEventId,
    type: event.type,
    emailId: event.data?.email_id || null,
    receivedAt: new Date().toISOString(),
  });
  if (!first) {
    const prior = await kvGet(PROVIDER_EVENT_RESULT_KEY(providerEventId));
    return { duplicate: true, ...(prior || {}) };
  }

  const providerMessageId = event.data?.email_id;
  const message = await getMessageByProviderId(providerMessageId);
  if (!message) {
    const result = { resolved: false, providerMessageId, providerEventId, eventType: event.type, retryable: true };
    // A provider webhook can race the request that is persisting the message.
    // Release the event guard so a provider retry can resolve it later.
    await kvDelete(dedupeKey);
    await recordAudit("PROVIDER_EVENT_MESSAGE_NOT_FOUND", result);
    return result;
  }

  const providerEventReceivedAt = event.created_at || new Date().toISOString();
  const priorEventAt = message.providerDelivery?.providerEventReceivedAt || null;
  const incomingTime = new Date(providerEventReceivedAt).getTime();
  const priorTime = priorEventAt ? new Date(priorEventAt).getTime() : NaN;
  if (Number.isFinite(priorTime) && Number.isFinite(incomingTime) && incomingTime < priorTime) {
    const result = {
      resolved: true,
      stale: true,
      messageId: message.messageId,
      providerMessageId,
      providerEventId,
      eventType: event.type,
      emailDeliveryStatus: message.emailDeliveryStatus,
      formsDeliveryStatus: message.formsDelivery?.status || "NOT_REQUESTED",
    };
    await kvSet(PROVIDER_EVENT_RESULT_KEY(providerEventId), result);
    await recordAudit("PROVIDER_EVENT_STALE_IGNORED", {
      messageId: message.messageId,
      providerMessageId,
      providerEventId,
      providerEventType: event.type,
      providerEventReceivedAt,
      currentProviderEventReceivedAt: priorEventAt,
    });
    return result;
  }

  const finalDelivered = event.type === "email.delivered";
  const failed = event.type === "email.failed" || event.type === "email.bounced";
  const hasForms = Boolean(message.attachments?.length);
  const attachmentResults = hasForms
    ? await Promise.all(
        message.attachments.map((attachment) =>
          markAttachmentDelivery(
            attachment.attachmentId,
            mapping.attachment,
            finalDelivered ? providerEventReceivedAt : null
          )
        )
      )
    : [];

  const updatedAttachments = hasForms
    ? message.attachments.map((attachment, index) => attachmentResults[index] || attachment)
    : [];

  const formsDelivery = hasForms
    ? {
        ...(message.formsDelivery || {}),
        status: mapping.forms,
        deliveredAt: finalDelivered ? providerEventReceivedAt : null,
        failedAt: failed ? providerEventReceivedAt : null,
        providerEventId,
        providerEventType: event.type,
      }
    : message.formsDelivery || { status: "NOT_REQUESTED", attachmentCount: 0, attachmentIds: [] };

  const updated = await updateMessage(message.messageId, {
    emailDeliveryStatus: mapping.email,
    deliveredAt: finalDelivered ? providerEventReceivedAt : null,
    failedAt: failed ? providerEventReceivedAt : null,
    attachments: updatedAttachments,
    formsDelivery,
    providerDelivery: {
      provider: "RESEND",
      providerMessageId,
      providerEventId,
      providerEventType: event.type,
      providerEventReceivedAt,
      providerDeliveryStatus: mapping.email,
      bounce: event.data?.bounce || null,
      failure: event.data?.failed || null,
    },
  });

  await setOfferState(message.offerNumber, {
    emailGateway: {
      deliveryStatus: mapping.email,
      deliveredAt: finalDelivered ? providerEventReceivedAt : "",
      formsDeliveryStatus: formsDelivery.status,
      providerMessageId,
      providerEventId,
      providerEventType: event.type,
      providerEventReceivedAt,
    },
  });

  await recordAudit(mapping.audit, {
    messageId: message.messageId,
    offerNumber: message.offerNumber,
    baseOfferNumber: message.baseOfferNumber || message.offerNumber,
    offerVersion: message.offerVersion || 1,
    providerMessageId,
    providerEventId,
    providerEventType: event.type,
    emailDeliveryStatus: mapping.email,
    formsDeliveryStatus: formsDelivery.status,
  });
  if (hasForms && finalDelivered) {
    await recordAudit("FORMS_DELIVERY_CONFIRMED", {
      messageId: message.messageId,
      offerNumber: message.offerNumber,
      formsPackageId: message.formsPackageId,
      formsPackageSnapshotId: message.formsPackageSnapshotId,
      providerEventId,
      deliveredAt: providerEventReceivedAt,
    });
  }
  if (hasForms && failed) {
    await recordAudit("FORMS_DELIVERY_FAILED", {
      messageId: message.messageId,
      offerNumber: message.offerNumber,
      formsPackageId: message.formsPackageId,
      formsPackageSnapshotId: message.formsPackageSnapshotId,
      providerEventId,
      providerEventType: event.type,
    });
  }

  const result = {
    resolved: true,
    messageId: message.messageId,
    providerMessageId,
    providerEventId,
    eventType: event.type,
    emailDeliveryStatus: mapping.email,
    formsDeliveryStatus: formsDelivery.status,
  };
  await kvSet(PROVIDER_EVENT_RESULT_KEY(providerEventId), result);
  return { ...result, message: updated };
}
