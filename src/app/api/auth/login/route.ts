import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/crypto";
import { createToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!username || !password) {
      return NextResponse.json({ error: "أدخل اسم المستخدم وكلمة المرور" }, { status: 400 });
    }
    const user = await db.adminUser.findUnique({ where: { username } });
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
      return NextResponse.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }
    // v4: resolve the tenant organization (null organizationId = platform staff)
    const org = user.organizationId
      ? await db.organization.findUnique({ where: { id: user.organizationId } })
      : null;
    if (user.organizationId && (!org || !org.active)) {
      return NextResponse.json({ error: "المؤسسة غير متاحة — اتصل بمسؤول المنصة" }, { status: 401 });
    }
    await db.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await db.activityLog.create({
      data: { actor: user.name, action: "تسجيل دخول", details: "دخول ناجح إلى النظام" },
    });
    const token = createToken({ uid: user.id, name: user.name, role: user.role, organizationId: user.organizationId });
    // token also returned in the body: client keeps it as an Authorization: Bearer
    // fallback for contexts where the browser blocks cookies (cross-origin preview iframe).
    const res = NextResponse.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, role: user.role },
      org: org
        ? {
            code: org.code,
            name: org.name,
            plan: org.plan,
            subscriptionStatus: org.subscriptionStatus,
            brandName: org.brandName,
            brandPrimary: org.brandPrimary,
            logoUrl: org.logoUrl,
          }
        : null,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req));
    return res;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error("[auth/login] failed:", msg);
    const dbIssue = /database|prisma|table|schema|connect|env|tenant|host|ECONNREFUSED|P1001|P1002|P2025/i.test(msg);
    return NextResponse.json({
      error: dbIssue
        ? "قاعدة البيانات غير جاهزة — تحقق من DATABASE_URL وتشغيل prisma db push على Vercel"
        : "خطأ في الخادم — راجع سجلات Vercel",
      ...(process.env.NODE_ENV !== "production" ? { detail: msg } : {}),
    }, { status: 500 });
  }
}
