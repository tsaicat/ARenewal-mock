import { kvGet, kvSet, kvSetIfAbsent, listPush, listRange } from "./store.js";
import { arEmailKey } from "./keyspace.js";

const RESPONSE_EVENT_KEY = (eventId) => arEmailKey("response-event", eventId);
const FAMILY_RESPONSES_KEY = (baseOfferNumber) => arEmailKey("offer-family", baseOfferNumber, "responses");

export async function saveResponseEvent(event) {
  await kvSet(RESPONSE_EVENT_KEY(event.eventId), event);
  const indexed = await kvSetIfAbsent(arEmailKey("response-event-indexed", event.eventId), { at: new Date().toISOString() });
  if (indexed) await listPush(FAMILY_RESPONSES_KEY(event.baseOfferNumber || event.offerNumber), event.eventId, 1000);
  return event;
}

export async function getResponseEvent(eventId) {
  return kvGet(RESPONSE_EVENT_KEY(eventId));
}

export async function listFamilyResponseEvents(baseOfferNumber, limit = 500) {
  const ids = await listRange(FAMILY_RESPONSES_KEY(baseOfferNumber), 0, limit - 1);
  const events = await Promise.all(ids.map((id) => kvGet(RESPONSE_EVENT_KEY(id))));
  return events.filter(Boolean).sort((a, b) => String(a.receivedAt || "").localeCompare(String(b.receivedAt || "")));
}
