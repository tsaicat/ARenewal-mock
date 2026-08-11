import { NextResponse } from "next/server";
import { qaCookieName } from "@/lib/security";
export const dynamic = "force-dynamic";
export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(qaCookieName(), "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
