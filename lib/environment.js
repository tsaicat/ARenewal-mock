// lib/environment.js — explicit runtime/environment policy for MOCK-AR-API v0.5.0.

export function environmentMode() {
  const explicit = String(process.env.MOCK_ENV_MODE || "").trim().toLowerCase();
  if (["development", "test", "production", "deployed"].includes(explicit)) {
    return explicit === "deployed" ? "production" : explicit;
  }
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

export function isProductionMode() {
  return environmentMode() === "production";
}

export function explicitBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function retentionDays() {
  const n = Number(process.env.MOCK_DATA_RETENTION_DAYS || 30);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : 30;
}

export function retentionTtlSeconds() {
  return retentionDays() * 24 * 60 * 60;
}
