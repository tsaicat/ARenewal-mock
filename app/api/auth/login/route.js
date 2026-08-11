import { NextResponse } from "next/server";
import { createQaSessionCookie, qaAuthConfigured, qaCookieName, qaSessionTtlSeconds, verifyQaPassword } from "@/lib/security";
import { enforceRateLimit } from "@/lib/rateLimit";
import { isProductionMode } from "@/lib/environment";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const rate = await enforceRateLimit(req, "auth");
  if (!rate.ok) return rate.response;
  if (!qaAuthConfigured()) {
    return NextResponse.json(
      { error: "QA authentication is not configured", code: "QA_AUTH_CONFIGURATION_REQUIRED" },
      { status: isProductionMode() ? 503 : 409 }
    );
  }
  let payload = {};
  try { payload = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body", code: "VALIDATION_FAILED" }, { status: 400 }); }
  if (!verifyQaPassword(payload.password)) {
    await recordAudit("QA_LOGIN_FAILED", { reason: "Invalid credentials" }).catch(() => {});
    return NextResponse.json({ error: "Invalid QA Inbox credentials", code: "QA_AUTH_FAILED" }, { status: 401 });
  }
  const token = createQaSessionCookie(payload.user || "qa-user");
  const response = NextResponse.json({ authenticated: true, expiresInSeconds: qaSessionTtlSeconds() });
  response.cookies.set(qaCookieName(), token, {
    httpOnly: true,
    secure: isProductionMode(),
    sameSite: "lax",
    path: "/",
    maxAge: qaSessionTtlSeconds(),
  });
  await recordAudit("QA_LOGIN_SUCCEEDED", { actor: payload.user || "qa-user" }).catch(() => {});
  return response;
}
