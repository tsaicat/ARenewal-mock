import { NextResponse } from "next/server";
import { qaAuthenticationRequired, qaAuthConfigured, qaSessionFromRequest } from "@/lib/security";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const session = qaSessionFromRequest(req);
  const required = qaAuthenticationRequired();
  return NextResponse.json({
    authenticated: Boolean(session) || (!required && !qaAuthConfigured()),
    authenticationRequired: required,
    authenticationConfigured: qaAuthConfigured(),
    actor: session?.sub || null,
    expiresAt: session?.exp ? new Date(session.exp * 1000).toISOString() : null,
  });
}
