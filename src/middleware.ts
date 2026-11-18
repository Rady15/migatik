import { NextRequest, NextResponse } from "next/server";

/**
 * In-memory sliding-window rate limiter (single-instance deployments).
 * - general API: 900 req / minute / IP (≈15 req/s — a NOC dashboard polls ~20
 *   req/min per session, so this accommodates ~40 simultaneous sessions while
 *   still blocking abuse)
 * - auth endpoints (login): 10 req / minute / IP — brute-force protection
 * Note (honest scope): single-instance counter. For multi-replica deployments
 * move the counter to Redis (documented in PRODUCTION_READINESS_REPORT.md).
 */

const windows = new Map<string, number[]>();
const WINDOW_MS = 60_000;

function allow(key: string, limit: number): { ok: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= limit) {
    windows.set(key, arr);
    const oldest = arr[0];
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
  }
  arr.push(now);
  windows.set(key, arr);
  // opportunistic cleanup
  if (windows.size > 10_000) {
    for (const [k, v] of windows) {
      if (v.every((t) => now - t >= WINDOW_MS)) windows.delete(k);
    }
  }
  return { ok: true, remaining: limit - arr.length, retryAfterSec: 0 };
}

export function middleware(req: NextRequest) {
  const ip =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "local";
  const path = req.nextUrl.pathname;

  const isAuth = path.startsWith("/api/auth/login") || path.startsWith("/api/auth/logout");
  const isApi = path.startsWith("/api/");

  if (!isApi) return NextResponse.next();

  const { ok, remaining, retryAfterSec } = isAuth ? allow(`auth:${ip}`, 10) : allow(`api:${ip}`, 900);
  const res = ok ? NextResponse.next() : NextResponse.json({ error: "عدد كبير من الطلبات — حاول بعد قليل" }, { status: 429 });
  res.headers.set("X-RateLimit-Limit", String(isAuth ? 10 : 900));
  res.headers.set("X-RateLimit-Remaining", String(remaining));
  if (!ok) res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
