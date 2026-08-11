import { requireAdmin, requirePasWrite, requireQaOrServiceRead, requireQaSession } from "./security.js";
import { enforceRateLimit } from "./rateLimit.js";

async function rateFirst(req, scope) {
  const rate = await enforceRateLimit(req, scope, null);
  return rate.ok ? null : rate.response;
}

export async function securePasWrite(req, scope = "send", operation = "PAS_WRITE") {
  const rateResponse = await rateFirst(req, scope);
  if (rateResponse) return { ok: false, response: rateResponse };
  return requirePasWrite(req, operation);
}
export async function secureRead(req, scope = "read", operation = "QA_READ") {
  const rateResponse = await rateFirst(req, scope);
  if (rateResponse) return { ok: false, response: rateResponse };
  return requireQaOrServiceRead(req, operation);
}
export async function secureQaAction(req, scope = "reply", operation = "QA_ACTION") {
  const rateResponse = await rateFirst(req, scope);
  if (rateResponse) return { ok: false, response: rateResponse };
  return requireQaSession(req, operation);
}
export async function secureAdmin(req, scope = "admin", operation = "ADMIN") {
  const rateResponse = await rateFirst(req, scope);
  if (rateResponse) return { ok: false, response: rateResponse };
  return requireAdmin(req, operation);
}
