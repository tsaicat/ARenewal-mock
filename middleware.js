import { NextResponse } from "next/server";

function environmentMode() {
  const explicit = String(process.env.MOCK_ENV_MODE || "").trim().toLowerCase();
  if (["production", "deployed"].includes(explicit)) return "production";
  if (explicit === "test") return "test";
  if (explicit === "development") return "development";
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") return "production";
  return process.env.NODE_ENV === "test" ? "test" : "development";
}

function allowedOrigins(req) {
  const configured = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const defaults = environmentMode() === "production" ? [] : ["http://localhost:3000", "http://localhost:5173"];
  return new Set([req.nextUrl.origin, ...defaults, ...configured]);
}

function applySecurityHeaders(response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const devEval = environmentMode() === "development" ? " 'unsafe-eval'" : "";
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${devEval}; connect-src 'self'`
  );
  return response;
}

export function middleware(req) {
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins(req);
  if (isApi && origin && !allowed.has(origin)) {
    return applySecurityHeaders(
      NextResponse.json({ error: "Origin is not allowed", code: "CORS_ORIGIN_DENIED" }, { status: 403 })
    );
  }

  if (isApi && req.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    if (origin && allowed.has(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
      response.headers.set("Access-Control-Allow-Credentials", "true");
      response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Accept, Authorization, X-Mock-Api-Key, X-Mock-Admin-Key, X-PAS-Integration-Namespace"
      );
      response.headers.set("Access-Control-Max-Age", "600");
    }
    return applySecurityHeaders(response);
  }

  const response = NextResponse.next();
  if (isApi && origin && allowed.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return applySecurityHeaders(response);
}

export const config = { matcher: ["/:path*"] };
