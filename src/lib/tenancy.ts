import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession, SessionPayload } from "@/lib/session";
import { runWithTenant } from "@/lib/tenant-context";

/**
 * v4 multi-tenant organization resolution & commercial gating.
 *
 * - ORG users: token carries organizationId → strict isolation via src/lib/db.ts.
 * - SUPER_ADMIN (platform staff): may pass `x-active-org: <code>` header to
 *   operate inside one organization (audited), otherwise sees everything.
 * - Suspended organizations: every tenant endpoint returns 403 SUBSCRIPTION_SUSPENDED
 *   (past_due keeps working but responses carry X-Subscription-Warning).
 */

export interface OrgContext {
  /** Organization the request operates in (null = platform-level overview). */
  effectiveOrgId: string | null;
  isPlatform: boolean;
  role: string;
  userId: string;
  username: string;
  org: {
    id: string;
    code: string;
    name: string;
    plan: string;
    subscriptionStatus: string;
    brandName: string | null;
    brandPrimary: string | null;
    logoUrl: string | null;
    maxRouters: number;
    maxUsers: number;
    maxVouchersPerBatch: number;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
  } | null;
}

function orgResponse(org: NonNullable<OrgContext["org"]>) {
  return {
    id: org.id,
    code: org.code,
    name: org.name,
    plan: org.plan,
    subscriptionStatus: org.subscriptionStatus,
    brandName: org.brandName,
    brandPrimary: org.brandPrimary,
    logoUrl: org.logoUrl,
    maxRouters: org.maxRouters,
    maxUsers: org.maxUsers,
    maxVouchersPerBatch: org.maxVouchersPerBatch,
    trialEndsAt: org.trialEndsAt,
    currentPeriodEnd: org.currentPeriodEnd,
  };
}

type OrgRow = NonNullable<Awaited<ReturnType<typeof db.organization.findFirst>>>;

export async function requireOrg(req?: NextRequest): Promise<{ ctx: OrgContext } | { response: NextResponse }> {
  const session: SessionPayload | null = await getSession();
  if (!session) {
    return { response: NextResponse.json({ error: "غير مصرح — يرجى تسجيل الدخول" }, { status: 401 }) };
  }
  const unauth = () => NextResponse.json({ error: "الحساب غير مرتبط بمؤسسة" }, { status: 401 });

  let orgRow: OrgRow | null = null;
  let isPlatform = false;

  if (session.organizationId) {
    orgRow = await db.organization.findUnique({ where: { id: session.organizationId } });
    if (!orgRow || !orgRow.active) {
      return { response: NextResponse.json({ error: "المؤسسة غير متاحة — اتصل بمسؤول المنصة" }, { status: 401 }) };
    }
  } else if (session.role === "SUPER_ADMIN") {
    isPlatform = true;
    const activeCode = req?.headers.get("x-active-org")?.trim();
    if (activeCode) {
      orgRow = await db.organization.findUnique({ where: { code: activeCode } });
      if (!orgRow) {
        return { response: NextResponse.json({ error: "المؤسسة المطلوبة غير موجودة" }, { status: 400 }) };
      }
      await db.activityLog.create({
        data: {
          actor: session.name,
          action: "platform_org_switch",
          target: orgRow.code,
          details: "مشغّل المنصة يتعامل داخل مؤسسة",
        },
      });
    }
  } else {
    return { response: unauth() };
  }

  if (orgRow && orgRow.subscriptionStatus === "suspended" && !isPlatform) {
    return {
      response: NextResponse.json(
        {
          error: "تم تعليق الاشتراك — جدّد الخطة أو اتصل بمسؤول المنصة",
          code: "SUBSCRIPTION_SUSPENDED",
        },
        { status: 403 },
      ),
    };
  }

  const ctx: OrgContext = {
    effectiveOrgId: orgRow?.id ?? null,
    isPlatform,
    role: session.role,
    userId: session.uid,
    username: session.name,
    org: orgRow
      ? orgResponse({
          id: orgRow.id,
          code: orgRow.code,
          name: orgRow.name,
          plan: orgRow.plan,
          subscriptionStatus: orgRow.subscriptionStatus,
          brandName: orgRow.brandName,
          brandPrimary: orgRow.brandPrimary,
          logoUrl: orgRow.logoUrl,
          maxRouters: orgRow.maxRouters,
          maxUsers: orgRow.maxUsers,
          maxVouchersPerBatch: orgRow.maxVouchersPerBatch,
          trialEndsAt: orgRow.trialEndsAt ? orgRow.trialEndsAt.toISOString() : null,
          currentPeriodEnd: orgRow.currentPeriodEnd ? orgRow.currentPeriodEnd.toISOString() : null,
        })
      : null,
  };
  return { ctx };
}

export function withOrg(handler: (req: NextRequest, ctx: OrgContext) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    const g = await requireOrg(req);
    if ("response" in g) return g.response;
    const ctx = g.ctx;
    return runWithTenant(
      { organizationId: ctx.effectiveOrgId ?? "unassigned", isPlatform: ctx.isPlatform },
      () => handler(req, ctx),
    );
  };
}

/** Strict variant for tenant-scoped endpoints (rejects platform overview mode). */
export function withOrgStrict(handler: (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => Promise<Response>) {
  return withOrg(async (req, ctx) => {
    if (!ctx.effectiveOrgId) {
      return NextResponse.json({ error: "حدد المؤسسة عبر الترويسة x-active-org" }, { status: 400 });
    }
    return handler(req, ctx as OrgContext & { effectiveOrgId: string });
  });
}

/** Platform-only endpoints (SaaS operator console). */
export async function requirePlatform(): Promise<{ session: SessionPayload } | { response: NextResponse }> {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return { response: NextResponse.json({ error: "غير مصرح — صلاحية مشغّل المنصة مطلوبة" }, { status: 401 }) };
  }
  return { session };
}

/** Daily usage metering for SaaS limits & billing. */
export async function meter(organizationId: string, metric: string, delta = 1): Promise<void> {
  if (!organizationId || organizationId === "unassigned") return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await db.usageCounter.upsert({
      where: { organizationId_day_metric: { organizationId, day, metric } },
      update: { value: { increment: delta } },
      create: { organizationId, day, metric, value: delta },
    });
  } catch {
    // metering must never break the business operation
  }
}
