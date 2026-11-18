import crypto from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * ONE-COMMAND ROUTER ENROLLMENT.
 *
 * Flow (mirrors the "paste this line in the MikroTik terminal" vendor flow):
 *
 *  1. the dashboard creates a RouterEnrollment (token hash + generated API
 *     credentials, encrypted) and shows a single RouterOS line:
 *
 *       /tool fetch url=".../api/onboard/install/<token>" dst-path="mtcm_install.rsc"; :delay 3; /import file-name="mtcm_install.rsc"
 *
 *  2. the router downloads /api/onboard/install/<token> — a RouterOS script —
 *     and imports it. The script creates a dedicated API account, enables the
 *     API service, registers a heartbeat, then calls back.
 *  3. /api/onboard/callback/<token> creates the Router row, dials the API with
 *     the generated credentials and reports the real device info. Only a real
 *     successful login is ever stored as "online".
 *
 * Security: the token is public-but-ephemeral (30 min, SHA-256 at rest), the
 * .rsc is served with no-store, and it stops working once installed/expired.
 * Use HTTPS in production: the .rsc carries the API password once.
 */

export const ENROLL_TTL_MINUTES = 30;
export const API_USERNAME = "mtcm-cloud";

export function newEnrollToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashEnrollToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function isValidEnrollToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,80}$/.test(token);
}

/** RouterOS-safe password: letters/digits only, no quoting surprises in .rsc. */
export function newApiPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(24);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function normalizeBaseUrl(raw?: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** URL the ROUTER must be able to reach (LAN IP in local deployments). */
export function baseUrlFromRequest(req: NextRequest, override?: string | null): string {
  const chosen = normalizeBaseUrl(override) ?? normalizeBaseUrl(process.env.PUBLIC_PLATFORM_URL);
  if (chosen) return chosen;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

/** Accept only something that can be dialed as a host (IPv4/IPv6/hostname). */
export function sanitizeHost(raw?: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (!/^[0-9A-Za-z._:-]{3,253}$/.test(s)) return null;
  return s;
}

/** One line the user pastes into the RouterOS terminal (WebFig → New Terminal). */
export function renderOneLine(baseUrl: string, token: string): string {
  const tls = baseUrl.startsWith("https://") ? " check-certificate=no" : "";
  return `/tool fetch url="${baseUrl}/api/onboard/install/${token}" dst-path="mtcm_install.rsc"${tls}; :delay 3; /import file-name="mtcm_install.rsc"`;
}

export interface InstallScriptVars {
  baseUrl: string;
  token: string;
  apiUsername: string;
  apiPassword: string;
  hint: string;
}

/**
 * The .rsc served to the router. ASCII-only on purpose: RouterOS imports script
 * files reliably with plain ASCII, and comments here are diagnostic only.
 *
 * Re-running it is safe: the group/user/script/scheduler are created only when
 * missing, and the password is rotated to the current enrollment value.
 */
export function renderInstallScript(v: InstallScriptVars): string {
  const tls = v.baseUrl.startsWith("https://") ? " check-certificate=no" : "";
  const base = v.baseUrl.replace(/"/g, "");
  const token = v.token.replace(/[^A-Za-z0-9_-]/g, "");
  const user = v.apiUsername.replace(/[^A-Za-z0-9._-]/g, "");
  const pass = v.apiPassword.replace(/[^A-Za-z0-9]/g, "");
  const hint = v.hint.replace(/[^A-Za-z0-9]/g, "");

  return `# ============================================================================
#  MikroTik Cloud Manager - automatic router enrollment
#  enrollment: ...${hint}   generated: ${new Date().toISOString()}
#
#  Creates a dedicated API account, enables the API service, registers a
#  heartbeat, then calls the platform back so the router appears automatically.
#  Applied once by /import - no credentials of yours are read or changed.
# ============================================================================

:local mtcmBase "${base}"
:local mtcmToken "${token}"
:local mtcmUser "${user}"
:local mtcmPass "${pass}"
:local mtcmIps ""

# --- 0) report every static IPv4 address we have; the platform tries each one
#         with a real API login and keeps the address that actually answers
:foreach i in=[/ip address find] do={
  :if ([/ip address get $i dynamic] != "true") do={
    :local ad [/ip address get $i address]
    :local cut [:find $ad "/"]
    :local one ""
    :if ([:typeof $cut] = "nil") do={
      :set one $ad
    } else={
      :set one [:pick $ad 0 $cut]
    }
    :if ($mtcmIps = "") do={
      :set mtcmIps $one
    } else={
      :set mtcmIps "$mtcmIps,$one"
    }
  }
}

# --- 1) dedicated API group (minimum policies the platform needs)
:if ([:len [/user group find where name="mtcm-api"]] = 0) do={
  /user group add name="mtcm-api" policy=api,read,write,test
}

# --- 2) dedicated API user (re-running rotates the password)
:if ([:len [/user find where name=$mtcmUser]] = 0) do={
  /user add name=$mtcmUser group=mtcm-api password=$mtcmPass comment="mtcm-managed: cloud manager API" disabled=no
} else={
  /user set [find where name=$mtcmUser] group=mtcm-api password=$mtcmPass comment="mtcm-managed: cloud manager API" disabled=no
}

# --- 3) the API service must be enabled for the platform to log in.
#         Iterate and check the name explicitly -- RouterOS find-where-name
#         can resolve to the wrong service (e.g. telnet) when imported from a file.
#         Never change the port: an existing custom port keeps working.
:do {
  :foreach i in=[/ip service find] do={
    :if ([/ip service get $i name] = "api") do={
      /ip service set $i disabled=no
    }
  }
} on-error={}

# --- 4) heartbeat every 5 minutes (router -> platform; no open port needed)
:local hbUrl "${base}/api/onboard/heartbeat/${token}"
:if ([:len [/system script find where name="mtcm-heartbeat"]] = 0) do={
  /system script add name="mtcm-heartbeat" policy=read,write,test,ftp source="/tool fetch url=$hbUrl keep-result=no${tls}"
} else={
  /system script set [find where name="mtcm-heartbeat"] policy=read,write,test,ftp source="/tool fetch url=$hbUrl keep-result=no${tls}"
}
:if ([:len [/system scheduler find where name="mtcm-heartbeat"]] = 0) do={
  /system scheduler add name="mtcm-heartbeat" interval=5m comment="mtcm-managed: heartbeat" on-event="mtcm-heartbeat" policy=read,write,test,ftp disabled=no
} else={
  /system scheduler set [find where name="mtcm-heartbeat"] interval=5m policy=read,write,test,ftp disabled=no
}

# --- 5) call back: the platform creates the server row, verifies the API
#         login and reports the real identity/version (no fake "online")
:do {
  /tool fetch url="${base}/api/onboard/callback/${token}?a=$mtcmIps" keep-result=no${tls}
} on-error={
  :log warning "mtcm: callback failed - is the platform URL reachable from this router?"
}

:log info "mtcm: enrollment script applied"
`;
}

/** Per-IP sliding window shared by the public onboarding endpoints. */
export function makeRateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return function allow(ip: string): boolean {
    const now = Date.now();
    const key = ip || "unknown";
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.set(key, arr);
    if (arr.length >= limit) return false;
    arr.push(now);
    if (hits.size > 5_000) {
      for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    return true;
  };
}

export function plainText(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
