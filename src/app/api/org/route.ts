import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withOrg, withOrgStrict, type OrgContext } from "@/lib/tenancy";
import { badRequest, serverError } from "@/lib/api-auth";

/**
 * v4 Commercial SaaS — own-organization endpoint.
 * GET: full profile (plan, subscription, limits, brand) + current usage
 *      (routers/users/subscribers counts + last-30-days UsageCounter rollup)
 *      + latest 12 platform invoices.
 * PATCH: identity/branding update (name, brandName, brandPrimary, logoUrl) —
 *      ORG_ADMIN / ADMIN only, audited.
 */

const MANAGER_ROLES = new Set(["ORG_ADMIN", "ADMIN"]);
const METRICS_30D = ["routers", "devices_online", "vouchers_generated"] as const;
const DAY_MS = 24 * 3600 * 1000;

export const GET = withOrg(async (_req: NextRequest, ctx: OrgContext) => {
  try {
    if (!ctx.effectiveOrgId || !ctx.org) {
      return badRequest("حدد المؤسسة عبر الترويسة x-active-org");
    }
    const orgId = ctx.effectiveOrgId;
    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      return NextResponse.json({ error: "المؤسسة غير موجودة" }, { status: 404 });
    }
    const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
    const [routers, users, subscribers, counters, invoices] = await Promise.all([
      db.router.count({ where: { organizationId: orgId } }),
      db.adminUser.count({ where: { organizationId: orgId } }),
      db.subscriber.count({ where: { organizationId: orgId } }),
      db.usageCounter.findMany({
        where: { organizationId: orgId, day: { gte: since }, metric: { in: [...METRICS_30D] } },
      }),
      db.orgInvoice.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    let routersMetered = 0;
    let devicesOnlineMax = 0;
    let vouchersGenerated = 0;
    for (const c of counters) {
      if (c.metric === "routers") routersMetered += c.value;
      else if (c.metric === "devices_online") devicesOnlineMax = Math.max(devicesOnlineMax, c.value);
      else if (c.metric === "vouchers_generated") vouchersGenerated += c.value;
    }

    return NextResponse.json({
      org: {
        id: org.id,
        code: org.code,
        name: org.name,
        plan: org.plan,
        subscriptionStatus: org.subscriptionStatus,
        trialEndsAt: org.trialEndsAt,
        currentPeriodStart: org.currentPeriodStart,
        currentPeriodEnd: org.currentPeriodEnd,
        maxRouters: org.maxRouters,
        maxUsers: org.maxUsers,
        maxVouchersPerBatch: org.maxVouchersPerBatch,
        brandName: org.brandName,
        brandPrimary: org.brandPrimary,
        logoUrl: org.logoUrl,
        suspendedAt: org.suspendedAt,
        suspensionReason: org.suspensionReason,
        createdAt: org.createdAt,
      },
      usage: {
        routers,
        users,
        subscribers,
        usage30d: {
          routers: Math.round(routersMetered),
          devicesOnlineMax: Math.round(devicesOnlineMax),
          vouchersGenerated: Math.round(vouchersGenerated),
        },
      },
      invoices: invoices.map((i) => ({
        id: i.id,
        plan: i.plan,
        amount: i.amount,
        currency: i.currency,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        status: i.status,
        paidAt: i.paidAt,
        createdAt: i.createdAt,
      })),
    });
  } catch (e) {
    return serverError(e);
  }
});

export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    if (!MANAGER_ROLES.has(ctx.role)) {
      return NextResponse.json({ error: "غير مصرح — تتطلب صلاحية مدير المؤسسة (ORG_ADMIN / ADMIN)" }, { status: 403 });
    }
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const data: { name?: string; brandName?: string | null; brandPrimary?: string | null; logoUrl?: string | null } = {};

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 2) return badRequest("اسم المؤسسة قصير جداً (حرفان على الأقل)");
      data.name = name;
    }
    if (b.brandName !== undefined) {
      const brandName = String(b.brandName).trim();
      if (brandName.length > 60) return badRequest("اسم العلامة طويل جداً (60 حرفاً كحد أقصى)");
      data.brandName = brandName || null;
    }
    if (b.brandPrimary !== undefined) {
      const color = String(b.brandPrimary).trim();
      if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
        return badRequest("لون الهوية يجب أن يكون بصيغة #RRGGBB");
      }
      data.brandPrimary = color || null;
    }
    if (b.logoUrl !== undefined) {
      const logo = String(b.logoUrl).trim();
      if (logo && !/^https:\/\/\S+$/.test(logo)) {
        return badRequest("رابط الشعار يجب أن يكون رابط https صالحاً (أو فارغاً)");
      }
      data.logoUrl = logo || null;
    }

    if (Object.keys(data).length === 0) {
      return badRequest("لا توجد بيانات للتحديث");
    }

    const org = await db.organization.update({ where: { id: ctx.effectiveOrgId }, data });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "تحديث هوية المؤسسة",
        target: org.code,
        details: `الحقول المعدّلة: ${Object.keys(data).join(", ")}`,
        organizationId: ctx.effectiveOrgId,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "تم تحديث هوية المؤسسة بنجاح — ستظهر على شاشة تسجيل الدخول",
      org: {
        id: org.id,
        code: org.code,
        name: org.name,
        plan: org.plan,
        subscriptionStatus: org.subscriptionStatus,
        brandName: org.brandName,
        brandPrimary: org.brandPrimary,
        logoUrl: org.logoUrl,
      },
    });
  } catch (e) {
    return serverError(e);
  }
});
