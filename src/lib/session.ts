import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";

/**
 * HMAC-signed session tokens stored in an httpOnly cookie.
 * Payload: {uid, name, role, exp}
 */
const SECRET = process.env.APP_SECRET || "mikrotik-cloud-manager-fallback-secret";
export const SESSION_COOKIE = "mtcm_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  uid: string;
  name: string;
  role: string;
  /** v4 multi-tenant: organization the user belongs to (null = platform staff). */
  organizationId?: string | null;
  exp: number;
}

function sign(data: string): string {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function createToken(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** True when the request arrived over HTTPS (directly or through a TLS-terminating proxy). */
export function isSecureRequest(req?: NextRequest | Request): boolean {
  const proto = req?.headers?.get("x-forwarded-proto") ?? "";
  if (proto) return proto.split(",")[0].trim() === "https";
  try {
    return new URL(req?.url ?? "http://localhost").protocol === "https:";
  } catch {
    return false;
  }
}

export interface SessionCookieOptions {
  httpOnly: boolean;
  sameSite: "lax" | "none";
  secure: boolean;
  partitioned?: boolean;
  path: string;
  maxAge: number;
}

/**
 * Cookie attributes that work in BOTH access contexts:
 * - HTTPS via the preview proxy (incl. cross-origin <iframe>): SameSite=None + Secure + Partitioned (CHIPS),
 *   otherwise the browser drops the cookie and every API call returns 401.
 * - Plain HTTP top-level access (e.g. http://localhost:3000): SameSite=Lax ("none" without Secure is rejected).
 */
export function sessionCookieOptions(req?: NextRequest | Request): SessionCookieOptions {
  if (isSecureRequest(req)) {
    return { httpOnly: true, sameSite: "none", secure: true, partitioned: true, path: "/", maxAge: MAX_AGE_SEC };
  }
  return { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: MAX_AGE_SEC };
}

/** Read session from cookie; falls back to Authorization: Bearer <token> for contexts where cookies are blocked (cross-origin preview iframes). */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const fromCookie = verifyToken(store.get(SESSION_COOKIE)?.value);
  if (fromCookie) return fromCookie;
  try {
    const h = await headers();
    const auth = h.get("authorization");
    if (auth?.startsWith("Bearer ")) return verifyToken(auth.slice(7).trim());
  } catch {}
  return null;
}
