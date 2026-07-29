// lib/messages.js — CRUD-ish helpers for stored outbound messages.

import { kvGet, kvSet, listPush, listRange } from "./store";
import { arEmailKey } from "./keyspace";

const MESSAGE_KEY = (id) => arEmailKey("message", id);
const MESSAGES_INDEX = arEmailKey("messages", "index"); // list of messageIds, newest first

export async function saveMessage(message) {
  await kvSet(MESSAGE_KEY(message.messageId), message);
  await listPush(MESSAGES_INDEX, message.messageId, 1000);
}

export async function getMessage(messageId) {
  return kvGet(MESSAGE_KEY(messageId));
}

export async function updateMessage(messageId, patch) {
  const existing = await getMessage(messageId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await kvSet(MESSAGE_KEY(messageId), updated);
  return updated;
}

export async function listMessages(limit = 100) {
  const ids = await listRange(MESSAGES_INDEX, 0, limit - 1);
  const messages = await Promise.all(ids.map((id) => getMessage(id)));
  return messages.filter(Boolean);
}
