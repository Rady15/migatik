import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { readLiveMonitoring } from "@/lib/live-monitoring";

// One-time cleanup of the old inflated samples (bytes treated as bits/sec).
// A module-level flag avoids wiping the fresh live samples on every 15s poll.
const g = globalThis as typeof globalThis & { __mcm_metricPurged?: boolean; __mcm_orphansPurged?: boolean };

/**
 * Repair legacy data: older server deletes left HotspotUser/HotspotSession rows
 * with routerId=null (Prisma SetNull on the optional relation). They keep the
 * dashboard KPIs (total users / active sessions / recent users) alive with
 * phantom numbers even when zero routers exist. Run once per process.
 */
async function purgeOrphanDeviceData() {
  // Bypass the org scope: legacy rows were written with organizationId="unassigned"
  // by the scheduler, so an org-scoped purge would miss them.
  const allRouters = await db.router.findMany({ select: { id: true } });
  const validIds = new Set(allRouters.map((r) => r.id));
  // A device user/session is an orphan when it has no router, or its router is gone.
  const users = await db.$queryRaw<{ id: string; routerId: string | null }[]>`SELECT id, "routerId" FROM HotspotUser`;
  const orphanUserIds = users.filter((u) => !u.routerId || !validIds.has(u.routerId)).map((u) => u.id);
  const sessions = await db.$queryRaw<{ id: string; routerId: string | null }[]>`SELECT id, "routerId" FROM HotspotSession`;
  const orphanSessionIds = sessions.filter((s) => !s.routerId || !validIds.has(s.routerId)).map((s) => s.id);

  if (orphanSessionIds.length) {
    await db.$executeRaw`DELETE FROM HotspotSession WHERE id IN (${Prisma.join(orphanSessionIds)})`;
  }
  if (orphanUserIds.length) {
    await db.$executeRaw`DELETE FROM HotspotUser WHERE id IN (${Prisma.join(orphanUserIds)})`;
  }
  return { users: orphanUserIds.length, sessions: orphanSessionIds.length };
}

export const GET = withOrg(async (req: NextRequest) => {
  try {
    // Repair orphaned rows left by the old (non-cascading) server delete.
    if (!g.__mcm_orphansPurged) {
      const removed = await purgeOrphanDeviceData();
      if (removed.users || removed.sessions) {
        console.log(`[dashboard] purged orphan device data: ${removed.users} users, ${removed.sessions} sessions`);
      }
      g.__mcm_orphansPurged = true;
    }
    const routerId = req.nextUrl.searchParams.get("routerId");
    const filtered = Boolean(routerId && routerId !== "all");
    const routerWhere = filtered ? { routerId: routerId! } : {};
    // Router rows are keyed by their own id, not by a routerId column.
    const routerSelfWhere = filtered ? { id: routerId! } : {};
    // Payments have no router column — attribute them through the subscriber
    // (direct payment.subscriberId or invoice.subscriberId).
    const paymentWhere = routerId && routerId !== "all"
      ? { OR: [{ subscriber: { routerId } }, { invoice: { subscriber: { routerId } } }] }
      : {};

    // Real traffic + sessions read directly from the router.
    if (!g.__mcm_metricPurged) {
      await db.routerMetric.deleteMany({}).catch(() => {});
      const staleCache = await db.networkResource.findMany({ where: { source: "interface_traffic" } });
      if (staleCache.length) {
        await db.networkResource.deleteMany({ where: { id: { in: staleCache.map((r) => r.id) } } }).catch(() => {});
      }
      g.__mcm_metricPurged = true;
    }
    const live = await readLiveMonitoring(routerId && routerId !== "all" ? [routerId] : undefined);
    const liveAt = new Date();
    for (const t of live.traffic) {
      await db.routerMetric.create({
        data: {
          routerId: t.routerId,
          ts: liveAt,
          downloadMbps: t.downloadMbps,
          uploadMbps: t.uploadMbps,
          activeUsers: t.activeUsers,
          cpuLoad: 0,
        },
      }).catch(() => {});
    }

    const metrics = await db.routerMetric.findMany({
      where: { ...routerWhere, ts: { gte: new Date(Date.now() - 24 * 3600e3) } },
      orderBy: { ts: "asc" },
      select: { ts: true, downloadMbps: true, uploadMbps: true, activeUsers: true },
    });

    const [totalPaymentsAgg, usersTotal, usersActive, usersSuspended, usersExpired, servers, serversOnline, paymentsAll, vouchers, unreadNotifs, settings] = await Promise.all([
      db.payment.aggregate({ where: paymentWhere, _sum: { amount: true } }),
      db.hotspotUser.count({ where: routerWhere }),
      db.hotspotUser.count({ where: { ...routerWhere, status: "active" } }),
      db.hotspotUser.count({ where: { ...routerWhere, status: "suspended" } }),
      db.hotspotUser.count({ where: { ...routerWhere, status: "expired" } }),
      db.router.findMany({ where: routerSelfWhere, select: { id: true, name: true, host: true, status: true } }),
      db.router.count({ where: { ...routerSelfWhere, status: "online" } }),
      db.payment.findMany({ where: paymentWhere, select: { amount: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
      db.voucher.count({ where: routerWhere }),
      db.notification.count({ where: { read: false } }),
      db.setting.findMany({ where: { key: { in: ["map_users", "org_name"] } } }),
    ]);

    // Live active-session count (replaces the stale DB-only count).
    const activeSessions = live.sessions.length;

    // payments growth: current calendar month vs previous month
    const nowDate = new Date();
    const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
    const prevMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1);
    const thisMonth = paymentsAll.filter((p) => p.createdAt >= monthStart).reduce((a, p) => a + p.amount, 0);
    const prevMonth = paymentsAll.filter((p) => p.createdAt >= prevMonthStart && p.createdAt < monthStart).reduce((a, p) => a + p.amount, 0);
    const growth = prevMonth > 0 ? Math.round(((thisMonth - prevMonth) / prevMonth) * 1000) / 10 : 0;
    const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    const todayRevenue = paymentsAll.filter((p) => p.createdAt >= todayStart).reduce((a, p) => a + p.amount, 0);

    // network usage: average per hour bucket
    const hourly = new Map<string, { d: number; u: number; n: number; users: number }>();
    for (const m of metrics) {
      const h = m.ts.toISOString().slice(0, 13);
      const cur = hourly.get(h) ?? { d: 0, u: 0, n: 0, users: 0 };
      cur.d += m.downloadMbps;
      cur.u += m.uploadMbps;
      cur.users += m.activeUsers;
      cur.n += 1;
      hourly.set(h, cur);
    }
    const network = Array.from(hourly.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([h, v]) => ({
        time: h.slice(11) + ":00",
        download: Math.round((v.d / v.n) * 10) / 10,
        upload: Math.round((v.u / v.n) * 10) / 10,
        users: Math.round(v.users / v.n),
      }));

    // recent 5 sessions
    const recent = await db.hotspotSession.findMany({
      where: { status: "active", ...routerWhere },
      orderBy: { startedAt: "desc" },
      take: 5,
      include: {
        user: { select: { packageId: true } },
        router: { select: { name: true } },
      },
    });
    const pkgIds = recent.map((r) => r.user?.packageId).filter(Boolean) as string[];
    const pkgs = pkgIds.length ? await db.package.findMany({ where: { id: { in: pkgIds } } }) : [];
    const recentUsers = recent.map((r) => {
      const pkg = pkgs.find((p) => p.id === r.user?.packageId);
      return {
        id: r.id,
        username: r.username,
        speed: pkg ? (pkg.name === "Premium" ? "Premium" : `${pkg.downloadMbps} Mbps`) : "—",
        status: "متصل",
        durationSec: Math.max(1, Math.floor((Date.now() - r.startedAt.getTime()) / 1000)),
        startedAt: r.startedAt,
      };
    });

    // user growth (this month vs last)
    const newThisMonth = await db.hotspotUser.count({ where: { ...routerWhere, createdAt: { gte: monthStart } } });
    const newPrevMonth = await db.hotspotUser.count({ where: { ...routerWhere, createdAt: { gte: prevMonthStart, lt: monthStart } } });
    const usersGrowth = newPrevMonth > 0 ? Math.round(((newThisMonth - newPrevMonth) / newPrevMonth) * 1000) / 10 : 8;

    const mapUsers = settings.find((s) => s.key === "map_users")?.value ?? "{}";
    const connRate = servers.length > 0 ? Math.round((serversOnline / servers.length) * 1000) / 10 : 0;

    return NextResponse.json({
      kpis: {
        totalPayments: Math.round((totalPaymentsAgg._sum.amount ?? 0) * 100) / 100,
        paymentsGrowth: growth,
        usersTotal,
        usersGrowth,
        serversCount: servers.length,
        serversOnline,
        connectionRate: connRate,
        todayRevenue: Math.round(todayRevenue * 100) / 100,
        activeSessions,
        unreadNotifications: unreadNotifs,
      },
      userStatus: { online: usersActive, suspended: usersSuspended, expired: usersExpired },
      network,
      recentUsers,
      quickStats: { activeUsers: usersTotal, cards: vouchers, revenue: Math.round((totalPaymentsAgg._sum.amount ?? 0) * 100) / 100 },
      servers,
      mapUsers: JSON.parse(mapUsers),
    });
  } catch (e) {
    return serverError(e);
  }
});
