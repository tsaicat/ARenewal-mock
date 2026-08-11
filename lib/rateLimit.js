// lib/rateLimit.js — server-side fixed-window rate limiting.

import { NextResponse } from "next/server";
import { kvIncrementWithExpiry } from "./store.js";
import { arEmailKey } from "./keyspace.js";
import { rateIdentity } from "./security.js";

export const RATE_LIMITS = Object.freeze({
  send: { limit: 60, windowSeconds: 60 },
  acknowledgment: { limit: 30, windowSeconds: 60 },
  reply: { limit: 30, windowSeconds: 60 },
  read: { limit: 180, windowSeconds: 60 },
  attachment: { limit: 120, windowSeconds: 60 },
  auth: { limit: 20, windowSeconds: 60 },
  admin: { limit: 10, windowSeconds: 60 },
});

export async function enforceRateLimit(req, scope, principal = null, override = null) {
  const config = override || RATE_LIMITS[scope] || RATE_LIMITS.read;
  const identity = rateIdentity(req, principal);
  const window = Math.floor(Date.now() / (config.windowSeconds * 1000));
  const key = arEmailKey("rate", scope, identity, window);
  const count = await kvIncrementWithExpiry(key, config.windowSeconds + 5);
  if (count <= config.limit) return { ok: true, count, limit: config.limit };
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Rate limit exceeded", code: "RATE_LIMITED", retryAfter: config.windowSeconds },
      { status: 429, headers: { "Retry-After": String(config.windowSeconds) } }
    ),
  };
}
