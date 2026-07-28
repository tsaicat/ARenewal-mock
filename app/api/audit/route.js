import { NextResponse } from "next/server";
import { getAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const entries = await getAuditLog(300);
  return NextResponse.json({ entries });
}
