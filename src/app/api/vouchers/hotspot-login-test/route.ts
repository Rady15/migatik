import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { badRequest, serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { decryptSecret } from "@/lib/crypto";
import { enqueueAgentCommand } from "@/lib/agent-commands";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";

/**
 * v4 — REAL hotspot login test for one voucher (all four auth modes).
 *
 * The HTTP login attempt is performed INSIDE the customer LAN by the assigned
 * agent (outbound tunnel carries the result back); the created hotspot session
 * is then verified through the RouterOS API (tunnel or direct). The endpoint
 * reports raw HTTP evidence and the API session check — it never fabricates a
 * pass: unreachable agent/router or rejected login are returned as honest
 * failures.
 */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const { voucherId, httpPort } = await req.json().catch(() => ({} as Record<string, unknown>));
    if (!voucherId) return badRequest("voucherId مطلوب");
    const voucher = await db.voucher.findUnique({ where: { id: String(voucherId) }, include: { router: true } });
    if (!voucher) return badRequest("الكرت غير موجود");
    if (!voucher.router) return badRequest("الكرت غير مرتبط بسيرفر");

    const router = voucher.router;
    // credentials per auth mode (plaintext used transiently, never logged)
    let username = voucher.username;
    let password: string;
    try {
      password = voucher.passwordEnc ? decryptSecret(voucher.passwordEnc) : voucher.password;
    } catch {
      return badRequest("تعذر فك تشفير بيانات الكرت (APP_SECRET mismatch)");
    }
    if (voucher.authMode === "pin") password = voucher.username; // same code as username AND password
    if (voucher.authMode === "username_only") password = "";

    // 1) HTTP login attempt — inside the LAN via the agent (agent-managed routers)
    let httpEvidence: Record<string, unknown> | null = null;
    let httpError: string | null = null;
    if (router.connectionMethod === "agent") {
      if (!router.agentId) return NextResponse.json({ ok: false, error: "السيرفر مضبوط عبر وكيل لكن لا وكيل معيَّن" }, { status: 400 });
      const agentOnline = await (db as any).networkAgent.findUnique({ where: { id: router.agentId }, select: { status: true, lastSeenAt: true } });
      const online = agentOnline?.status === "online" && agentOnline?.lastSeenAt && Date.now() - new Date(agentOnline.lastSeenAt).getTime() < 60_000;
      if (!online) return NextResponse.json({ ok: false, error: "الوكيل غير متصل — لا يمكن تنفيذ اختبار الدخول داخل شبكة العميل" }, { status: 400 });
      const res = await enqueueAgentCommand<{ ok: boolean; evidence?: Record<string, unknown>; verdict?: string; error?: string }>(
        router.agentId,
        "hotspot_login_test",
        { host: router.host, httpPort: Number(httpPort ?? 80), username, password },
        { timeoutMs: 20000 },
      );
      if (!res.ok || !res.result?.ok) {
        httpError = res.error ?? res.result?.error ?? "فشل اختبار HTTP غير معروف";
      } else {
        httpEvidence = { ...res.result.evidence, verdict: res.result.verdict };
      }
    } else {
      // direct deployment (platform inside the same LAN / on-prem): attempt locally
      try {
        const base = `http://${router.host}:${Number(httpPort ?? 80)}`;
        const res = await fetch(
          `${base}/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&dst=${encodeURIComponent("http://192.168.88.254/")}&popup=true`,
          { redirect: "manual", signal: AbortSignal.timeout(8000) },
        );
        const body = await res.text().catch(() => "");
        httpEvidence = {
          statusCode: res.status,
          location: res.headers.get("location") ?? "",
          errorPageSignals: [/invalid/i, /cannot find/i, /wrong/i].filter((r) => r.test(body)).map(String),
        };
      } catch (e) {
        httpError = (e as Error).message;
      }
    }

    // 2) API verification: is there an active hotspot session for this user?
    const apiCheck = await withRouterRow(router, (conn) => runCommand(conn, ["/ip/hotspot/active/print", `?user=${username}`], 10000), { commandTimeoutMs: 12000 });
    const apiSession = apiCheck.ok
      ? (apiCheck.value?.data ?? []).filter((r) => String(r.user ?? r.username ?? "").toLowerCase() === username.toLowerCase())
      : [];
    const apiVerified = apiCheck.ok && apiSession.length > 0;

    // verdict: both pieces of evidence must agree — never a fabricated pass
    const httpAccepted = httpEvidence ? String((httpEvidence as { verdict?: string }).verdict ?? "") === "login-accepted" : false;
    return NextResponse.json({
      ok: true,
      voucher: { id: voucher.id, username: voucher.username, authMode: voucher.authMode, serial: voucher.serial },
      http: { evidence: httpEvidence, error: httpError, accepted: httpAccepted },
      api: { reachable: apiCheck.ok, activeSessions: apiSession.length, verified: apiVerified, error: apiCheck.error ?? null },
      verdict: httpAccepted && apiVerified ? "PASS" : "FAIL",
      note: "PASS يتطلب قبول HTTP فعلي من صفحة الهوتسبوت + جلسة نشطة مؤكدة من RouterOS API — لا يُقبول أي منهما بلا الآخر",
    });
  } catch (e) {
    return serverError(e);
  }
});
