import { createHmac, timingSafeEqual } from "crypto";
import { isProductionMode } from "./environment.js";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function secret() {
  const configured = process.env.MOCK_INTERNAL_CALLBACK_SECRET || process.env.QA_SESSION_SECRET || process.env.MOCK_API_KEY || "";
  if (configured) return configured;
  return isProductionMode() ? "" : "mock-ar-local-dev-internal-callback";
}
export function internalCallbackToken(eventId) {
  if (!secret()) return "";
  return createHmac("sha256", secret()).update(String(eventId || "")).digest("base64url");
}
export function verifyInternalCallback(req, eventId) {
  const expected = internalCallbackToken(eventId);
  const supplied = req.headers.get("x-mock-internal-callback") || "";
  return Boolean(expected && supplied && safeEqual(supplied, expected));
}
