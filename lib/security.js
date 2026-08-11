// lib/security.js — server-only authentication/session helpers.
// No privileged credential is ever exported to browser code.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { environmentMode, explicitBoolean, isProductionMode } from "./environment.js";
import { recordAudit } from "./audit.js";

const QA_COOKIE = "ar_mock_qa_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function bearerToken(req) {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function serviceCredentialConfigured() {
  return Boolean(process.env.MOCK_API_KEY);
}

export function qaAuthConfigured() {
  return Boolean(process.env.QA_INBOX_PASSWORD && process.env.QA_SESSION_SECRET);
}

export function adminCredentialConfigured() {
  return Boolean(process.env.MOCK_ADMIN_TOKEN);
}

export function authenticationRequired() {
  if (isProductionMode()) return true;
  return explicitBoolean("REQUIRE_API_AUTH", false);
}

export function qaAuthenticationRequired() {
  if (isProductionMode()) return true;
  return explicitBoolean("REQUIRE_QA_AUTH", false);
}

export function sessionSecret() {
  return process.env.QA_SESSION_SECRET || "";
}

export function serviceCredentialFromRequest(req) {
  return req.headers.get("x-mock-api-key") || bearerToken(req);
}

function signSessionPayload(encoded) {
  return createHmac("sha256", sessionSecret()).update(encoded).digest("base64url");
}

export function createQaSessionCookie(subject = "qa-user") {
  if (!qaAuthConfigured()) throw new Error("QA authentication is not configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: subject, iat: now, exp: now + SESSION_TTL_SECONDS, nonce: randomBytes(8).toString("hex") })).toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}

export function verifyQaSessionCookie(value) {
  if (!qaAuthConfigured() || !value) return null;
  const [payload, signature] = String(value).split(".");
  if (!payload || !signature || !safeEqual(signature, signSessionPayload(payload))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function cookieValue(req, name) {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function qaSessionFromRequest(req) {
  return verifyQaSessionCookie(cookieValue(req, QA_COOKIE));
}

export function requestPrincipal(req) {
  const supplied = serviceCredentialFromRequest(req);
  if (serviceCredentialConfigured() && supplied && safeEqual(supplied, process.env.MOCK_API_KEY)) {
    return { type: "PAS_SERVICE", id: "pas-service" };
  }
  const session = qaSessionFromRequest(req);
  if (session) return { type: "QA_SESSION", id: session.sub || "qa-user" };
  return null;
}

function authError(code, message, status = 401) {
  return NextResponse.json({ error: message, code }, { status });
}

async function auditDenied(req, operation, reason) {
  await recordAudit("UNAUTHORIZED_API_ATTEMPT", {
    operation,
    method: req.method,
    path: new URL(req.url).pathname,
    reason,
  }).catch(() => {});
}

export async function requirePasWrite(req, operation = "PAS_WRITE") {
  if (!authenticationRequired() && !serviceCredentialConfigured()) return { ok: true, principal: { type: "DEV_COMPAT", id: "development" } };
  if (isProductionMode() && !serviceCredentialConfigured()) {
    await auditDenied(req, operation, "MOCK_API_KEY is not configured");
    return { ok: false, response: authError("AUTH_CONFIGURATION_REQUIRED", "Service authentication is not configured.", 503) };
  }
  const supplied = serviceCredentialFromRequest(req);
  if (!supplied) {
    await auditDenied(req, operation, "missing credential");
    return { ok: false, response: authError("AUTH_REQUIRED", "Authentication is required.", 401) };
  }
  if (!serviceCredentialConfigured() || !safeEqual(supplied, process.env.MOCK_API_KEY)) {
    await auditDenied(req, operation, "invalid credential");
    return { ok: false, response: authError("FORBIDDEN", "The supplied credential is not authorized.", 403) };
  }
  return { ok: true, principal: { type: "PAS_SERVICE", id: "pas-service" } };
}

export async function requireQaOrServiceRead(req, operation = "QA_READ") {
  if (!qaAuthenticationRequired() && !authenticationRequired() && !qaAuthConfigured() && !serviceCredentialConfigured()) {
    return { ok: true, principal: { type: "DEV_COMPAT", id: "development" } };
  }
  const principal = requestPrincipal(req);
  if (principal) return { ok: true, principal };
  if (isProductionMode() && !qaAuthConfigured() && !serviceCredentialConfigured()) {
    await auditDenied(req, operation, "read authentication is not configured");
    return { ok: false, response: authError("AUTH_CONFIGURATION_REQUIRED", "QA/read authentication is not configured.", 503) };
  }
  await auditDenied(req, operation, "missing or invalid read credential/session");
  return { ok: false, response: authError("AUTH_REQUIRED", "QA or service authentication is required.", 401) };
}

export async function requireQaSession(req, operation = "QA_ACTION") {
  if (!qaAuthenticationRequired() && !qaAuthConfigured()) return { ok: true, principal: { type: "DEV_COMPAT", id: "development" } };
  if (isProductionMode() && !qaAuthConfigured()) {
    await auditDenied(req, operation, "QA auth configuration missing");
    return { ok: false, response: authError("AUTH_CONFIGURATION_REQUIRED", "QA authentication is not configured.", 503) };
  }
  const session = qaSessionFromRequest(req);
  if (!session) {
    await auditDenied(req, operation, "QA session missing/invalid");
    return { ok: false, response: authError("QA_AUTH_REQUIRED", "QA Inbox authentication is required.", 401) };
  }
  return { ok: true, principal: { type: "QA_SESSION", id: session.sub || "qa-user" } };
}

export async function requireAdmin(req, operation = "ADMIN") {
  // Destructive administration is privileged in every environment. Local development
  // may use a disposable MOCK_ADMIN_TOKEN, but there is no unauthenticated purge bypass.
  if (!adminCredentialConfigured()) {
    await auditDenied(req, operation, "MOCK_ADMIN_TOKEN missing");
    return { ok: false, response: authError("ADMIN_AUTH_CONFIGURATION_REQUIRED", "Administrative authentication is not configured.", 503) };
  }
  const supplied = req.headers.get("x-mock-admin-key") || bearerToken(req);
  if (!supplied || !safeEqual(supplied, process.env.MOCK_ADMIN_TOKEN)) {
    await auditDenied(req, operation, "admin credential missing/invalid");
    return { ok: false, response: authError("ADMIN_FORBIDDEN", "Administrative authorization is required.", supplied ? 403 : 401) };
  }
  return { ok: true, principal: { type: "ADMIN", id: "mock-admin" } };
}

export function verifyQaPassword(password) {
  return qaAuthConfigured() && safeEqual(password, process.env.QA_INBOX_PASSWORD);
}

export function qaCookieName() { return QA_COOKIE; }
export function qaSessionTtlSeconds() { return SESSION_TTL_SECONDS; }

export function securityDiagnostics() {
  return {
    environmentMode: environmentMode(),
    authenticationRequired: authenticationRequired(),
    serviceAuthenticationConfigured: serviceCredentialConfigured(),
    qaAuthenticationRequired: qaAuthenticationRequired(),
    qaAuthenticationConfigured: qaAuthConfigured(),
    adminAuthenticationConfigured: adminCredentialConfigured(),
  };
}

export function rateIdentity(req, principal = null) {
  if (principal?.id) return `${principal.type}:${principal.id}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anonymous";
  return `anon:${createHash("sha256").update(forwarded).digest("hex").slice(0, 20)}`;
}
