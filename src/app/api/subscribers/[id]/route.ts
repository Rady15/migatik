import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { runLifecycle, type LifecycleAction } from "@/lib/subscribers";

const ACTIONS: LifecycleAction[] = ["activate", "renew", "suspend", "reactivate", "migrate_package", "terminate"];

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

/** GET /api/subscribers/[id] — unified subscriber profile: everything linked to one account. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const sub = await db.subscriber.findFirst({
      where: { id },
      include: {
        package: true,
        router: { select: { id: true, name: true, host: true, status: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });
    if (!sub) return badRequest("المشترك غير موجود");

    const macs: string[] = sub.macAddresses ? JSON.parse(sub.macAddresses) : [];
    const macUpper = macs.map((m) => m.toUpperCase());

    const [devices, sessions, payments, invoices, vouchers, events, txs, subscriptions, usageDaily] = await Promise.all([
      // linked devices — by stored MACs on the subscriber's router
      macUpper.length
        ? db.networkDevice.findMany({
            where: { routerId: sub.routerId ?? undefined, macAddress: { in: macUpper.map((m) => m.toLowerCase()) } },
            select: {
              id: true, macAddress: true, ipAddress: true, hostname: true, customName: true,
              status: true, connectionType: true, interfaceName: true, vlanId: true,
              firstSeen: true, lastSeen: true, manufacturer: true,
            },
            take: 50,
          })
        : Promise.resolve([]),
      // sessions by router-side username
      sub.username
        ? db.hotspotSession.findMany({
            where: { username: sub.username, routerId: sub.routerId ?? undefined },
            orderBy: { startedAt: "desc" }, take: 30,
          })
        : Promise.resolve([]),
      db.payment.findMany({ where: { subscriberId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.invoice.findMany({ where: { subscriberId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      // vouchers sold to this subscriber (matched by username on the router)
      sub.username
        ? db.voucher.findMany({ where: { username: sub.username, routerId: sub.routerId ?? undefined }, orderBy: { createdAt: "desc" }, take: 30 })
        : Promise.resolve([]),
      db.subscriberEvent.findMany({ where: { subscriberId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.customerTx.findMany({ where: { subscriberId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.recurringSubscription.findMany({ where: { subscriberId: id } }),
      // 30-day usage of linked devices
      macUpper.length
        ? db.deviceTrafficDaily.findMany({
            where: { device: { routerId: sub.routerId ?? undefined, macAddress: { in: macUpper.map((m) => m.toLowerCase()) } } },
            orderBy: { day: "desc" }, take: 90,
            include: { device: { select: { macAddress: true, customName: true } } },
          })
        : Promise.resolve([]),
    ]);

    // IP/MAC history of linked devices
    const ipHistory = devices.length
      ? await db.deviceIpHistory.findMany({
          where: { device: { id: { in: devices.map((d) => d.id) } } },
          orderBy: { lastSeen: "desc" }, take: 50,
        })
      : [];

    const totalDownloadMb = usageDaily.reduce((a, u) => a + (u.downMb ?? 0), 0);
    const totalUploadMb = usageDaily.reduce((a, u) => a + (u.upMb ?? 0), 0);
    const paidTotal = payments.reduce((a, p) => a + p.amount, 0);
    const balance = txs.reduce((acc, t) => acc + t.amount, 0);

    return NextResponse.json({
      subscriber: { ...sub, macAddresses: macs },
      devices,
      sessions,
      payments,
      invoices,
      vouchers,
      events,
      transactions: txs,
      subscriptions,
      usage: { daily: usageDaily.slice(0, 30), totalDownloadMb, totalUploadMb },
      finance: { paidTotal, balance },
      ipHistory,
    });
  } catch (e) {
    return serverError(e);
  }
});

/** POST /api/subscribers/[id] — lifecycle action: activate/renew/suspend/reactivate/migrate/terminate. */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    const action = String(b.action ?? "") as LifecycleAction;
    if (!ACTIONS.includes(action)) return badRequest(`إجراء غير معروف: ${action}`);
    // target package for migrate_package must belong to the same organization
    if (b.packageId) {
      const pkg = await db.package.findFirst({ where: { id: String(b.packageId) } });
      if (!pkg) return badRequest("الباقة غير موجودة");
    }
    const result = await runLifecycle(id, action, ctx.username, {
      packageId: b.packageId ? String(b.packageId) : undefined,
      cycle: b.cycle ? String(b.cycle) : undefined,
      confirm: b.confirm === true,
    });
    if (!result.ok) return badRequest(result.error ?? "فشل تنفيذ العملية");
    return NextResponse.json({ ok: true, detail: result.detail, subscriber: result.subscriber });
  } catch (e) {
    return serverError(e);
  }
});

/** PATCH /api/subscribers/[id] — edit profile fields / link devices (MACs). */
export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    // router/branch/package FKs must belong to the same organization
    if (b.routerId) {
      const router = await db.router.findFirst({ where: { id: String(b.routerId) } });
      if (!router) return badRequest("السيرفر غير موجود");
    }
    if (b.branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(b.branchId) } });
      if (!branch) return badRequest("الفرع غير موجود");
    }
    if (b.packageId) {
      const pkg = await db.package.findFirst({ where: { id: String(b.packageId) } });
      if (!pkg) return badRequest("الباقة غير موجودة");
    }
    const data: Record<string, unknown> = {};
    for (const k of ["name", "phone", "email", "address", "username", "notes"] as const) {
      if (b[k] !== undefined) data[k] = b[k] === null ? null : String(b[k]);
    }
    for (const k of ["routerId", "branchId", "packageId"] as const) {
      if (b[k] !== undefined) data[k] = b[k] || null;
    }
    if (b.autoRenew !== undefined) data.autoRenew = b.autoRenew === true;
    if (b.expiresAt !== undefined) data.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    if (b.macAddresses !== undefined) {
      const macs = Array.isArray(b.macAddresses)
        ? b.macAddresses.map((m: string) => String(m).toUpperCase())
        : String(b.macAddresses).split(/[,\s]+/).filter(Boolean).map((m) => m.toUpperCase());
      data.macAddresses = JSON.stringify(macs);
    }
    const updated = await db.subscriber.update({ where: { id }, data });
    await db.activityLog.create({
      data: { actor: ctx.username, action: "subscriber:updated", target: updated.code, details: Object.keys(data).join(", ") },
    });
    return NextResponse.json({ ok: true, subscriber: updated });
  } catch (e) {
    return serverError(e);
  }
});
