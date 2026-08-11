// lib/messages.js — stored outbound messages + provider-id lookup.

import { kvGet, kvSet, listPush, listRange } from "./store.js";
import { arEmailKey } from "./keyspace.js";

const MESSAGE_KEY = (id) => arEmailKey("message", id);
const MESSAGES_INDEX = arEmailKey("messages", "index");
const PROVIDER_MESSAGE_KEY = (providerMessageId) => arEmailKey("provider-message", providerMessageId);

export async function saveMessage(message) {
  await kvSet(MESSAGE_KEY(message.messageId), message);
  await listPush(MESSAGES_INDEX, message.messageId, 1000);
  if (message.providerMessageId) await kvSet(PROVIDER_MESSAGE_KEY(message.providerMessageId), message.messageId);
}

export async function getMessage(messageId) {
  return kvGet(MESSAGE_KEY(messageId));
}

export async function getMessageByProviderId(providerMessageId) {
  if (!providerMessageId) return null;
  const messageId = await kvGet(PROVIDER_MESSAGE_KEY(providerMessageId));
  return messageId ? getMessage(messageId) : null;
}

export async function updateMessage(messageId, patch) {
  const existing = await getMessage(messageId);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...patch,
    providerDelivery: { ...(existing.providerDelivery || {}), ...(patch.providerDelivery || {}) },
    formsDelivery: { ...(existing.formsDelivery || {}), ...(patch.formsDelivery || {}) },
  };
  await kvSet(MESSAGE_KEY(messageId), updated);
  if (updated.providerMessageId) await kvSet(PROVIDER_MESSAGE_KEY(updated.providerMessageId), messageId);
  return updated;
}

export async function listMessages(limit = 100) {
  const ids = await listRange(MESSAGES_INDEX, 0, limit - 1);
  const messages = await Promise.all(ids.map((id) => getMessage(id)));
  return messages.filter(Boolean);
}
