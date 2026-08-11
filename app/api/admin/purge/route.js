import { NextResponse } from "next/server";
import { secureAdmin } from "@/lib/routeSecurity";
import { purgeAllMockData, purgeExpiredRecords } from "@/lib/retention";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export async function POST(req) {
  const access = await secureAdmin(req, "admin", "PURGE_MOCK_DATA");
  if (!access.ok) return access.response;
  let payload = {};
  try { payload = await req.json(); } catch {}
  const action = String(payload.action || "EXPIRED").toUpperCase();
  if (!['EXPIRED', 'ALL'].includes(action)) return NextResponse.json({ error: "action must be EXPIRED or ALL", code: "VALIDATION_FAILED" }, { status: 400 });
  if (action === 'ALL' && payload.confirm !== 'PURGE ALL MOCK EMAIL DATA') {
    return NextResponse.json({ error: "Explicit purge confirmation is required", code: "PURGE_CONFIRMATION_REQUIRED" }, { status: 400 });
  }
  const result = action === 'ALL' ? await purgeAllMockData() : await purgeExpiredRecords();
  await recordAudit("ADMIN_PURGE_COMPLETED", { action, ...result }).catch(() => {});
  return NextResponse.json({ action, ...result });
}
