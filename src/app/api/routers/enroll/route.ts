import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { badRequest, serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import {
  API_USERNAME,
  ENROLL_TTL_MINUTES,
  baseUrlFromRequest,
  hashEnrollToken,
  newApiPassword,
  newEnrollToken,
  renderOneLine,
  sanitizeHost,
} from "@/lib/router-enroll";

/**
 * One-command enrollment — dashboard side.
 *
 * POST { name, location?, category?, host?, baseUrl? }
 *   → { command, token, expiresAt, ... } — the token is returned ONCE.
 *
 * The command is pasted into the router terminal; the router then downloads a
 * RouterOS script from the public /api/onboard/install endpoint and calls back,
 * so no IP/port/credential is typed by hand.
 */

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json().catch(() => ({}));
    const name = String(b.name ?? "").trim();
    if (!name) return badRequest("اسم السيرفر مطلوب");

    // ---- plan limit (same rule as manual creation) ----
    const current = await db.router.count({ where: { organizationId: ctx.effectiveOrgId } });
    const max = ctx.org?.maxRouters ?? 3;
    if (current >= max) {
      return NextResponse.json(
        { error: `بلغت الحد الأقصى للسيرفرات في خطتك (${max}) — قم بترقية الخطة`, code: "PLAN_LIMIT_ROUTERS" },
        { status: 402 },
      );
    }

    const baseUrl = baseUrlFromRequest(req, b.baseUrl ? String(b.baseUrl) : null);
    if (!/^https?:\/\//.test(baseUrl)) return badRequest("عنوان المنصة غير صالح");

    const token = newEnrollToken();
    const tokenHash = hashEnrollToken(token);
    const apiPassword = newApiPassword();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MINUTES * 60_000);

    // one live code per organization — an older pending code is retired
    await db.routerEnrollment.updateMany({
      where: { organizationId: ctx.effectiveOrgId, status: "pending" },
      data: { status: "expired" },
    });

    const enrollment = await db.routerEnrollment.create({
      data: {
        organizationId: ctx.effectiveOrgId,
        tokenHash,
        tokenHint: token.slice(-4),
        name,
        location: b.location ? String(b.location).slice(0, 120) : null,
        category: b.category === "branch" ? "branch" : "main",
        apiUsername: API_USERNAME,
        apiPasswordEnc: encryptSecret(apiPassword),
        platformUrl: baseUrl,
        host: sanitizeHost(b.host ? String(b.host) : null),
        status: "pending",
        expiresAt,
      },
    });

    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "router:enroll_code",
        target: name,
        details: `one-command enrollment issued (${ENROLL_TTL_MINUTES} min, hash stored only)`,
      },
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      id: enrollment.id,
      token, // shown once — never readable again
      command: renderOneLine(baseUrl, token),
      baseUrl,
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: ENROLL_TTL_MINUTES,
    });
  } catch (e) {
    return serverError(e);
  }
});

export const GET = withOrgStrict(async (_req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const rows = await db.routerEnrollment.findMany({
      where: { organizationId: ctx.effectiveOrgId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, name: true, status: true, host: true, routerId: true,
        expiresAt: true, installedAt: true, installCount: true, tokenHint: true, createdAt: true,
      },
    });
    return NextResponse.json({ ok: true, enrollments: rows });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return badRequest("id مطلوب");
    const row = await db.routerEnrollment.findFirst({ where: { id, organizationId: ctx.effectiveOrgId } });
    if (!row) return NextResponse.json({ error: "الكود غير موجود" }, { status: 404 });
    await db.routerEnrollment.update({ where: { id: row.id }, data: { status: "cancelled" } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
