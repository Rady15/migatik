import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { requireAuth, serverError } from "@/lib/api-auth";

export async function GET() {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  try {
    const settings = await db.setting.findMany();
    const user = await db.adminUser.findUnique({ where: { id: auth.session.uid }, select: { name: true, username: true, role: true, lastLoginAt: true } });
    return NextResponse.json({ settings: Object.fromEntries(settings.map((s) => [s.key, s.value])), user });
  } catch (e) {
    return serverError(e);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  try {
    const b = await req.json();
    for (const key of ["org_name", "org_phone", "currency", "tax_rate", "voucher_prefix", "language", "theme", "auto_import_router_accounts"]) {
      if (b[key] !== undefined) {
        await db.setting.upsert({ where: { key }, update: { value: String(b[key]) }, create: { key, value: String(b[key]) } });
      }
    }
    if (b.newPassword) {
      const user = await db.adminUser.findUnique({ where: { id: auth.session.uid } });
      if (!user || !verifyPassword(String(b.currentPassword || ""), user.passwordHash)) {
        return NextResponse.json({ error: "كلمة المرور الحالية غير صحيحة" }, { status: 400 });
      }
      if (String(b.newPassword).length < 6) {
        return NextResponse.json({ error: "كلمة المرور الجديدة قصيرة جداً (6 أحرف على الأقل)" }, { status: 400 });
      }
      await db.adminUser.update({ where: { id: user.id }, data: { passwordHash: hashPassword(String(b.newPassword)) } });
    }
    if (b.name) await db.adminUser.update({ where: { id: auth.session.uid }, data: { name: String(b.name) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
