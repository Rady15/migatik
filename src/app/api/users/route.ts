import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { withOrg, withOrgStrict, type OrgContext } from "@/lib/tenancy";
import { badRequest, serverError } from "@/lib/api-auth";
import { hashPassword } from "@/lib/crypto";

/**
 * v4 Commercial SaaS — org-scoped user management.
 * GET:    list this organization's users (platform overview mode → 400 "حدد المؤسسة").
 * POST:   create a user (ORG_ADMIN/ADMIN only, plan limit maxUsers → 402 PLAN_LIMIT_USERS).
 * PATCH:  update active/role/name/password — target must belong to the same org,
 *         and the last active ORG_ADMIN can never be demoted/deactivated.
 */

const MANAGER_ROLES = new Set(["ORG_ADMIN", "ADMIN"]);
const ASSIGNABLE_ROLES = new Set(["ORG_ADMIN", "ADMIN", "MANAGER", "SUPPORT", "ACCOUNTANT", "VIEWER"]);

function randomPassword(len = 8): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export const GET = withOrg(async (_req: NextRequest, ctx: OrgContext) => {
  try {
    if (!ctx.effectiveOrgId) return badRequest("حدد المؤسسة");
    const users = await db.adminUser.findMany({
      where: { organizationId: ctx.effectiveOrgId },
      select: { id: true, username: true, name: true, role: true, active: true, lastLoginAt: true },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ users });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    if (!MANAGER_ROLES.has(ctx.role)) {
      return NextResponse.json({ error: "غير مصرح — تتطلب صلاحية مدير المؤسسة (ORG_ADMIN / ADMIN)" }, { status: 403 });
    }
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const username = String(b.username ?? "").trim();
    const name = String(b.name ?? "").trim();
    const role = String(b.role ?? "VIEWER").trim();

    if (!/^[a-zA-Z0-9._-]{3,}$/.test(username)) {
      return badRequest("اسم المستخدم يجب أن يكون 3 أحرف على الأقل (حروف إنجليزية/أرقام/._-)");
    }
    if (!name) return badRequest("أدخل الاسم الكامل للمستخدم");
    if (role === "SUPER_ADMIN") return badRequest("لا يمكن إنشاء مستخدم بصلاحية مدير المنصة");
    if (!ASSIGNABLE_ROLES.has(role)) {
      return badRequest("صلاحية غير معروفة — الصلاحيات المتاحة: ORG_ADMIN, ADMIN, MANAGER, SUPPORT, ACCOUNTANT, VIEWER");
    }

    // plan limit — maxUsers per organization
    const maxUsers = ctx.org?.maxUsers ?? 5;
    const count = await db.adminUser.count({ where: { organizationId: ctx.effectiveOrgId } });
    if (count >= maxUsers) {
      return NextResponse.json(
        {
          error: `بلغتم الحد الأقصى للمستخدمين في خطتكم الحالية (${maxUsers}) — قوموا بترقية الخطة لإضافة مستخدمين جدد`,
          code: "PLAN_LIMIT_USERS",
        },
        { status: 402 },
      );
    }

    // same-organization duplicate (global uniqueness enforced by the schema; cross-org collisions surface as P2002 below)
    const dup = await db.adminUser.findFirst({ where: { username } });
    if (dup) return badRequest("اسم المستخدم موجود بالأصل — اختر اسماً آخر");

    const provided = b.password !== undefined && String(b.password) !== "" ? String(b.password) : null;
    if (provided && provided.length < 6) return badRequest("كلمة المرور قصيرة (6 أحرف على الأقل)");
    const password = provided ?? randomPassword();

    let user;
    try {
      user = await db.adminUser.create({
        data: {
          username,
          name,
          role,
          passwordHash: hashPassword(password),
          active: true,
          organizationId: ctx.effectiveOrgId,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        return badRequest("اسم المستخدم موجود بالأصل — اختر اسماً آخر");
      }
      throw e;
    }

    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "إنشاء مستخدم",
        target: username,
        details: `role=${role}`,
        organizationId: ctx.effectiveOrgId,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "تم إنشاء المستخدم بنجاح",
      user: { id: user.id, username: user.username, name: user.name, role: user.role },
      password, // one-time — shown once, never logged or stored in clear
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
    const id = String(b.id ?? "").trim();
    if (!id) return badRequest("معرّف المستخدم مطلوب");

    // explicit same-organization check — a foreign id behaves like a missing row
    const target = await db.adminUser.findFirst({ where: { id, organizationId: ctx.effectiveOrgId } });
    if (!target) {
      return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return badRequest("الاسم لا يمكن أن يكون فارغاً");
      data.name = name;
    }
    if (b.role !== undefined) {
      const role = String(b.role).trim();
      if (role === "SUPER_ADMIN") return badRequest("لا يمكن منح صلاحية مدير المنصة");
      if (!ASSIGNABLE_ROLES.has(role)) {
        return badRequest("صلاحية غير معروفة — الصلاحيات المتاحة: ORG_ADMIN, ADMIN, MANAGER, SUPPORT, ACCOUNTANT, VIEWER");
      }
      data.role = role;
    }
    if (b.active !== undefined) data.active = Boolean(b.active);
    if (b.password !== undefined && String(b.password) !== "") {
      if (String(b.password).length < 6) return badRequest("كلمة المرور قصيرة (6 أحرف على الأقل)");
      data.passwordHash = hashPassword(String(b.password));
    }
    if (Object.keys(data).length === 0) return badRequest("لا توجد بيانات للتحديث");

    // guard: never demote/deactivate the last active ORG_ADMIN of the organization
    const losesAdmin =
      target.role === "ORG_ADMIN" &&
      target.active &&
      (data.active === false || (typeof data.role === "string" && data.role !== "ORG_ADMIN"));
    if (losesAdmin) {
      const activeAdmins = await db.adminUser.count({
        where: { organizationId: ctx.effectiveOrgId, role: "ORG_ADMIN", active: true },
      });
      if (activeAdmins <= 1) {
        return badRequest("لا يمكن تعطيل أو تخفيض صلاحية آخر مدير مؤسسة نشط — أنشئ مديراً آخر أولاً");
      }
    }

    await db.adminUser.update({ where: { id: target.id }, data });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "تحديث مستخدم",
        target: target.username,
        details: Object.keys(data).filter((k) => k !== "passwordHash").join(", ") || "—",
        organizationId: ctx.effectiveOrgId,
      },
    });

    return NextResponse.json({ ok: true, message: "تم تحديث بيانات المستخدم بنجاح" });
  } catch (e) {
    return serverError(e);
  }
});
