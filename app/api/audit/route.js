import { NextResponse } from "next/server";
import { getAuditLog } from "@/lib/audit";
import { secureRead } from "@/lib/routeSecurity";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const access = await secureRead(req, "read", "READ_AUDIT");
  if (!access.ok) return access.response;
  const entries = await getAuditLog(300);
  return NextResponse.json({ entries });
}
