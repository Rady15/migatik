import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict, meter, OrgContext } from "@/lib/tenancy";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

/** Another organization's row must behave exactly like a missing row → 404. */
function notFoundOr500(e: unknown) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
    return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });
  }
  return serverError(e);
}

export const GET = withOrgStrict(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const router = await db.router.findUnique({
      where: { id },
      select: {
        id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true,
        apiUsername: true, location: true, category: true, connectionMethod: true, notes: true,
        status: true, statusMessage: true, lastCheckedAt: true, lastOnlineAt: true,
        identity: true, version: true, boardName: true, uptime: true, cpuLoad: true,
        freeMemoryMb: true, totalMemoryMb: true, freeDiskMb: true, totalDiskMb: true, createdAt: true,
        agentId: true, branchId: true,
      },
    });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });
    return NextResponse.json({ router });
  } catch (e) {
    return serverError(e);
  }
});

export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    const data: Record<string, unknown> = {};
    for (const key of ["name", "host", "location", "notes", "category", "connectionMethod"]) {
      if (b[key] !== undefined) data[key] = String(b[key]);
    }
    if (b.apiPort !== undefined) data.apiPort = Number(b.apiPort) || 8728;
    if (b.apiSslPort !== undefined) data.apiSslPort = Number(b.apiSslPort) || 8729;
    if (b.useTls !== undefined) data.useTls = Boolean(b.useTls);
    if (b.apiUsername !== undefined) data.apiUsername = String(b.apiUsername);
    if (b.apiPassword) data.apiPasswordEnc = encryptSecret(String(b.apiPassword));
    if (Object.keys(data).length === 0) return NextResponse.json({ error: "لا توجد تغييرات" }, { status: 400 });
    const router = await db.router.update({ where: { id }, data });
    await db.activityLog.create({
      data: { actor: ctx.username, action: "تعديل سيرفر", target: router.name },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return notFoundOr500(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const router = await db.router.findUnique({ where: { id }, select: { name: true } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });

    // Remove every device-side record tied to this router so the dashboard KPIs
    // (total users / active users / sessions) do not keep counting orphans.
    await db.hotspotSession.deleteMany({ where: { routerId: id } });
    const removedUsers = (await db.hotspotUser.deleteMany({ where: { routerId: id } })).count;
    await db.subscriberEvent.deleteMany({ where: { subscriber: { routerId: id } } }).catch(() => {});
    await db.recurringSubscription.deleteMany({ where: { routerId: id } }).catch(() => {});
    const orphanSubscribers = await db.subscriber.findMany({ where: { routerId: id }, select: { id: true } });
    if (orphanSubscribers.length) {
      const subIds = orphanSubscribers.map((s) => s.id);
      await db.invoice.deleteMany({ where: { subscriberId: { in: subIds } } }).catch(() => {});
      await db.payment.deleteMany({ where: { subscriberId: { in: subIds } } }).catch(() => {});
      await db.customerTx.deleteMany({ where: { subscriberId: { in: subIds } } }).catch(() => {});
      await db.subscriberEvent.deleteMany({ where: { subscriberId: { in: subIds } } }).catch(() => {});
      await db.recurringSubscription.deleteMany({ where: { subscriberId: { in: subIds } } }).catch(() => {});
    }
    const removedSubscribers = (await db.subscriber.deleteMany({ where: { routerId: id } })).count;
    const removedPackages = (await db.package.deleteMany({ where: { routerId: id } })).count;
    await db.routerMetric.deleteMany({ where: { routerId: id } });
    await db.networkResource.deleteMany({ where: { routerId: id } });

    await db.router.delete({ where: { id } });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "حذف سيرفر",
        target: router.name,
        details: `تم الحذف مع ${removedUsers} مستخدم و${removedSubscribers} مشترك و${removedPackages} باقة وجميع الجلسات والبيانات المرتبطة`,
      },
    });
    await meter(ctx.effectiveOrgId, "routers", -1).catch(() => {});
    return NextResponse.json({ ok: true, removedUsers });
  } catch (e) {
    return notFoundOr500(e);
  }
});
