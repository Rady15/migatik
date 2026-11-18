import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { requirePlatform } from "@/lib/tenancy";
import { badRequest, serverError } from "@/lib/api-auth";
import { hashPassword } from "@/lib/crypto";
import { PLAN_LIMITS, PLANS, SUBSCRIPTION_STATUSES, limitsFor, planAr, statusAr, TRIAL_DAYS, PERIOD_DAYS } from "@/lib/saas-plans";

/**
 * v4 Commercial SaaS — platform operator console (SUPER_ADMIN only).
 * GET:   all organizations + usage counts (routers/users/subscribers/vouchers
 *        + today's UsageCounter sum).
 * POST:  create an organization with its first ORG_ADMIN + default branch.
 * PATCH: change plan / limits / subscription status, suspend & restore —
 *        every action audited + Arabic notification for the org.
 *
 * NOTE: runs OUTSIDE the tenant context on purpose (platform overview), so
 * organizationId is set explicitly on every tenant-owned write below.
 */

const DAY_MS = 24 * 3600 * 1000;

function randomPassword(len = 8): string {
  // unambiguous alphabet; generated once and returned to the operator — never logged
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function slugify(name: string): string {
  const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "org";
}

async function uniqueOrgCode(base: string): Promise<string> {
  let code = base;
  let n = 2;
  while (await db.organization.findUnique({ where: { code } })) {
    code = `${base}-${n++}`;
  }
  return code;
}

async function uniqueBranchCode(base: string): Promise<string> {
  let code = base;
  let n = 2;
  while (await db.branch.findUnique({ where: { code } })) {
    code = `${base}-${n++}`;
  }
  return code;
}

export async function GET() {
  const auth = await requirePlatform();
  if ("response" in auth) return auth.response;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const [orgs, routerCounts, userCounts, subscriberCounts, voucherCounts, usageToday] = await Promise.all([
      db.organization.findMany({ orderBy: { createdAt: "desc" } }),
      db.router.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.adminUser.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.subscriber.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.voucher.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.usageCounter.findMany({ where: { day }, select: { organizationId: true, value: true } }),
    ]);

    const countMap = (rows: { organizationId: string | null; _count: { _all: number } }[]) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        if (r.organizationId) m.set(r.organizationId, r._count._all);
      }
      return m;
    };
    const routers = countMap(routerCounts);
    const users = countMap(userCounts);
    const subscribers = countMap(subscriberCounts);
    const vouchers = countMap(voucherCounts);
    const usage = new Map<string, number>();
    for (const u of usageToday) {
      usage.set(u.organizationId, (usage.get(u.organizationId) ?? 0) + u.value);
    }

    return NextResponse.json({
      orgs: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        code: o.code,
        active: o.active,
        plan: o.plan,
        subscriptionStatus: o.subscriptionStatus,
        trialEndsAt: o.trialEndsAt,
        currentPeriodStart: o.currentPeriodStart,
        currentPeriodEnd: o.currentPeriodEnd,
        maxRouters: o.maxRouters,
        maxUsers: o.maxUsers,
        maxVouchersPerBatch: o.maxVouchersPerBatch,
        suspendedAt: o.suspendedAt,
        suspensionReason: o.suspensionReason,
        createdAt: o.createdAt,
        counts: {
          routers: routers.get(o.id) ?? 0,
          users: users.get(o.id) ?? 0,
          subscribers: subscribers.get(o.id) ?? 0,
          vouchers: vouchers.get(o.id) ?? 0,
        },
        usageToday: Math.round(usage.get(o.id) ?? 0),
      })),
    });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatform();
  if ("response" in auth) return auth.response;
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    if (name.length < 2) return badRequest("أدخل اسم المؤسسة (حرفان على الأقل)");
    const plan = b.plan !== undefined && String(b.plan).trim() !== "" ? String(b.plan).trim() : "trial";
    if (!PLAN_LIMITS[plan]) return badRequest(`خطة غير معروفة — الخيارات: ${PLANS.join(", ")}`);

    const adminUsername = String(b.adminUsername ?? "").trim() || `${slugify(b.code ? String(b.code) : name)}-admin`;
    if (!/^[a-zA-Z0-9._-]{3,}$/.test(adminUsername)) {
      return badRequest("اسم المستخدم للمسؤول يجب أن يكون 3 أحرف على الأقل (حروف/أرقام/._-)");
    }
    const existingAdmin = await db.adminUser.findUnique({ where: { username: adminUsername } });
    if (existingAdmin) return badRequest("اسم المستخدم للمسؤول موجود بالأصل — اختر اسماً آخر");

    const providedPassword = b.adminPassword !== undefined && String(b.adminPassword) !== "" ? String(b.adminPassword) : null;
    if (providedPassword && providedPassword.length < 6) {
      return badRequest("كلمة المرور قصيرة (6 أحرف على الأقل)");
    }
    const password = providedPassword ?? randomPassword();

    const code = await uniqueOrgCode(b.code ? slugify(String(b.code)) : slugify(name));
    const now = new Date();
    const isTrial = plan === "trial";
    const trialEndsAt = isTrial ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : null;
    const periodEnd = isTrial ? trialEndsAt : new Date(now.getTime() + PERIOD_DAYS * DAY_MS);
    const limits = limitsFor(plan);

    const org = await db.organization.create({
      data: {
        name,
        code,
        plan,
        subscriptionStatus: isTrial ? "trialing" : "active",
        trialEndsAt,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        ...limits,
      },
    });

    const branch = await db.branch.create({
      data: { name: "الفرع الرئيسي", code: await uniqueBranchCode(`${code}-main`), organizationId: org.id },
    });

    const admin = await db.adminUser.create({
      data: {
        username: adminUsername,
        name: String(b.adminName ?? "").trim() || "مدير المؤسسة",
        role: "ORG_ADMIN",
        passwordHash: hashPassword(password),
        organizationId: org.id,
        branchId: branch.id,
      },
    });

    await db.activityLog.create({
      data: {
        organizationId: org.id,
        actor: auth.session.name,
        action: "إنشاء مؤسسة",
        target: org.code,
        details: `plan=${plan} admin=${adminUsername}`,
      },
    });
    await db.notification.create({
      data: {
        organizationId: org.id,
        title: "مرحباً بكم في المنصة",
        body: isTrial
          ? `تم إنشاء مؤسستكم بنجاح — الفترة التجريبية (${TRIAL_DAYS} يوماً) تنتهي في ${trialEndsAt?.toISOString().slice(0, 10)}. قوموا بترقية الخطة للاستمرار.`
          : "تم تفعيل اشتراك مؤسستكم بنجاح — نتمنى لكم تجربة موفقة.",
        type: "subscription",
        severity: "info",
      },
    });

    return NextResponse.json({
      ok: true,
      message: `تم إنشاء المؤسسة "${name}" بنجاح`,
      org: {
        id: org.id,
        name: org.name,
        code: org.code,
        plan: org.plan,
        subscriptionStatus: org.subscriptionStatus,
        trialEndsAt: org.trialEndsAt,
        currentPeriodEnd: org.currentPeriodEnd,
        limits,
      },
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        password, // one-time — shown to the operator once, never stored in clear or logged
      },
    });
  } catch (e) {
    return serverError(e);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requirePlatform();
  if ("response" in auth) return auth.response;
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    if (!id) return badRequest("معرّف المؤسسة مطلوب");
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) return NextResponse.json({ error: "المؤسسة غير موجودة" }, { status: 404 });

    const now = new Date();
    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    // plan change → re-derive limits from the plan map (explicit values win)
    if (b.plan !== undefined && String(b.plan).trim() !== "" && String(b.plan).trim() !== org.plan) {
      const plan = String(b.plan).trim();
      if (!PLAN_LIMITS[plan]) return badRequest(`خطة غير معروفة — الخيارات: ${PLANS.join(", ")}`);
      data.plan = plan;
      changed.push(`الخطة → ${planAr(plan)}`);
      const derived = limitsFor(plan);
      if (b.maxRouters === undefined) data.maxRouters = derived.maxRouters;
      if (b.maxUsers === undefined) data.maxUsers = derived.maxUsers;
      if (b.maxVouchersPerBatch === undefined) data.maxVouchersPerBatch = derived.maxVouchersPerBatch;
    }

    for (const key of ["maxRouters", "maxUsers", "maxVouchersPerBatch"] as const) {
      if (b[key] !== undefined && b[key] !== null && String(b[key]) !== "") {
        const n = parseInt(String(b[key]), 10);
        if (!Number.isFinite(n) || n < 1) return badRequest("الحدود يجب أن تكون أرقاماً موجبة");
        data[key] = n;
      }
    }

    if (b.subscriptionStatus !== undefined && String(b.subscriptionStatus).trim() !== "" && b.action === undefined) {
      const status = String(b.subscriptionStatus).trim();
      if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
        return badRequest(`حالة اشتراك غير معروفة — الخيارات: ${SUBSCRIPTION_STATUSES.join(", ")}`);
      }
      data.subscriptionStatus = status;
      changed.push(`حالة الاشتراك → ${statusAr(status)}`);
    }

    // lifecycle actions
    let severity: "warning" | "info" = "info";
    let notifBody = "";
    if (b.action === "suspend") {
      const reason = String(b.suspensionReason ?? "").trim() || "عدم السداد";
      data.subscriptionStatus = "suspended";
      data.suspendedAt = now;
      data.suspensionReason = reason;
      changed.push("تعليق الاشتراك");
      severity = "warning";
      notifBody = `تم تعليق اشتراك مؤسستكم — السبب: ${reason}. اتصلوا بمسؤول المنصة لإعادة التفعيل.`;
    } else if (b.action === "restore") {
      data.subscriptionStatus = "active";
      data.suspendedAt = null;
      data.suspensionReason = null;
      data.currentPeriodEnd = new Date(now.getTime() + PERIOD_DAYS * DAY_MS);
      changed.push("استئناف الاشتراك");
      notifBody = "تم استئناف اشتراك مؤسستكم — الفترة الجديدة لمدة 30 يوماً.";
    } else if (b.action !== undefined && b.action !== "") {
      return badRequest("إجراء غير معروف — الإجراءات المدعومة: suspend / restore");
    }

    if (!notifBody && changed.length > 0) {
      notifBody = `تم تحديث اشتراك مؤسستكم: ${changed.join(" · ")}`;
    }

    if (Object.keys(data).length === 0) {
      return badRequest("لا توجد تغييرات — حدّد خطة أو حدوداً أو إجراءً");
    }

    const updated = await db.organization.update({ where: { id }, data });

    await db.activityLog.create({
      data: {
        organizationId: id,
        actor: auth.session.name,
        action: changed.join(" · ") || "تحديث بيانات مؤسسة",
        target: updated.code,
        details: `plan=${updated.plan} status=${updated.subscriptionStatus} limits=${updated.maxRouters}/${updated.maxUsers}/${updated.maxVouchersPerBatch}`,
      },
    });
    if (notifBody) {
      await db.notification.create({
        data: { organizationId: id, title: "تحديث الاشتراك", body: notifBody, type: "subscription", severity },
      });
    }

    return NextResponse.json({
      ok: true,
      message: "تم تحديث المؤسسة بنجاح",
      org: {
        id: updated.id,
        name: updated.name,
        code: updated.code,
        plan: updated.plan,
        subscriptionStatus: updated.subscriptionStatus,
        maxRouters: updated.maxRouters,
        maxUsers: updated.maxUsers,
        maxVouchersPerBatch: updated.maxVouchersPerBatch,
        suspendedAt: updated.suspendedAt,
        suspensionReason: updated.suspensionReason,
        currentPeriodEnd: updated.currentPeriodEnd,
      },
    });
  } catch (e) {
    return serverError(e);
  }
}
