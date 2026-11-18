import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, meter, OrgContext } from "@/lib/tenancy";

export const GET = withOrg(async () => {
  try {
    const routers = await db.router.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true,
        apiUsername: true, location: true, category: true, connectionMethod: true, notes: true,
        status: true, statusMessage: true, lastCheckedAt: true, lastOnlineAt: true,
        identity: true, version: true, boardName: true, uptime: true, cpuLoad: true,
        freeMemoryMb: true, totalMemoryMb: true, freeDiskMb: true, totalDiskMb: true,
        createdAt: true,
      },
    });
    const counts = await Promise.all(
      routers.map(async (r) => ({
        id: r.id,
        users: await db.hotspotUser.count({ where: { routerId: r.id } }),
        sessions: await db.hotspotSession.count({ where: { routerId: r.id, status: "active" } }),
      })),
    );
    return NextResponse.json({
      routers: routers.map((r) => ({ ...r, ...counts.find((c) => c.id === r.id) })),
    });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.name || !b.host || !b.apiUsername || !b.apiPassword) {
      return NextResponse.json({ error: "الاسم وعنوان IP وبيانات API مطلوبة" }, { status: 400 });
    }
    // ---- P5 plan limit enforcement ----
    const current = await db.router.count({ where: { organizationId: ctx.effectiveOrgId } });
    const max = ctx.org?.maxRouters ?? 3;
    if (current >= max) {
      return NextResponse.json(
        { error: `بلغت الحد الأقصى للسيرفرات في خطتك (${max}) — قم بترقية الخطة`, code: "PLAN_LIMIT_ROUTERS" },
        { status: 402 },
      );
    }
    // branch must belong to the same organization
    let branchId: string | null = null;
    if (b.branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(b.branchId) } });
      if (!branch) return NextResponse.json({ error: "الفرع غير موجود" }, { status: 400 });
      branchId = branch.id;
    }
    const method = ["direct", "agent", "wireguard_agent"].includes(String(b.connectionMethod))
      ? String(b.connectionMethod)
      : "direct";
    const router = await db.router.create({
      data: {
        name: String(b.name),
        host: String(b.host),
        apiPort: Number(b.apiPort) || 8728,
        apiSslPort: Number(b.apiSslPort) || 8729,
        useTls: Boolean(b.useTls),
        apiUsername: String(b.apiUsername),
        apiPasswordEnc: encryptSecret(String(b.apiPassword)),
        location: b.location ? String(b.location) : null,
        category: b.category === "branch" ? "branch" : "main",
        connectionMethod: method,
        notes: b.notes ? String(b.notes) : null,
        status: "untested",
      },
    });
    await db.activityLog.create({
      data: { actor: ctx.username, action: "إضافة سيرفر", target: router.name, details: `تم تسجيل السيرفر ${router.host}` },
    });
    await meter(ctx.effectiveOrgId, "routers", 1);
    return NextResponse.json({ ok: true, router: { ...router, apiPasswordEnc: undefined } });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id مطلوب" }, { status: 400 });
    
    // 1) احذف المستخدمين والسessions المرتبطة بالسيرفر ده
    await db.hotspotUser.deleteMany({ where: { routerId: id } });
    await db.hotspotSession.deleteMany({ where: { routerId: id } });
    
    // 2) احذف السيرفر نفسه
    await db.router.delete({ where: { id } });
    
    await db.activityLog.create({
      data: { actor: ctx.username, action: "حذف سيرفر", target: id, details: "تم الحذف مع حذف المستخدمين associated" },
    }).catch(() => {});
    
    await meter(ctx.effectiveOrgId, "routers", -1).catch(() => {});
    
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e) {
    return serverError(e);
  }
});
