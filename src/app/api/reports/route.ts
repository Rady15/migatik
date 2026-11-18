import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const routerWhere = routerId && routerId !== "all" ? { routerId } : {};
    const paymentWhere = routerId && routerId !== "all"
      ? { OR: [{ subscriber: { routerId } }, { invoice: { subscriber: { routerId } } }] }
      : {};
    const since = new Date(Date.now() - 60 * 86400e3);
    const [payments, expenses, vouchersSold, pkgCounts, methodCounts, newUsers] = await Promise.all([
      db.payment.findMany({ where: { createdAt: { gte: since }, ...paymentWhere }, select: { amount: true, createdAt: true, method: true } }),
      db.expense.findMany({ where: { createdAt: { gte: since } }, select: { amount: true, createdAt: true, category: true } }),
      db.voucher.findMany({ where: { soldAt: { gte: since }, ...routerWhere }, select: { price: true, soldAt: true } }),
      db.hotspotUser.groupBy({ by: ["packageId"], where: routerWhere, _count: true }),
      db.payment.groupBy({ by: ["method"], where: { createdAt: { gte: since }, ...paymentWhere }, _count: true, _sum: { amount: true } }),
      db.hotspotUser.findMany({ where: { createdAt: { gte: since }, ...routerWhere }, select: { createdAt: true } }),
    ]);

    // daily revenue series (last 30 days)
    const days: { date: string; revenue: number; users: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3);
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, revenue: 0, users: 0 });
    }
    const dayMap = new Map(days.map((d) => [d.date, d]));
    for (const p of payments) {
      const k = p.createdAt.toISOString().slice(0, 10);
      const row = dayMap.get(k);
      if (row) row.revenue = Math.round((row.revenue + p.amount) * 100) / 100;
    }
    for (const u of newUsers) {
      const k = u.createdAt.toISOString().slice(0, 10);
      const row = dayMap.get(k);
      if (row) row.users += 1;
    }

    const packages = await db.package.findMany({
      where: routerId && routerId !== "all" ? { OR: [{ routerId }, { routerId: null }] } : {},
      select: { id: true, name: true },
    });
    const pkgPopularity = packages
      .map((p) => ({ name: p.name, count: pkgCounts.find((c) => c.packageId === p.id)?._count ?? 0 }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({
      daily: days,
      pkgPopularity,
      paymentMethods: methodCounts.map((m) => ({ method: m.method, count: m._count, total: m._sum.amount ?? 0 })),
      vouchersSoldByDay: (() => {
        const map: Record<string, number> = {};
        for (const v of vouchersSold) {
          const k = v.soldAt!.toISOString().slice(0, 10);
          map[k] = (map[k] ?? 0) + v.price;
        }
        return map;
      })(),
      totals: {
        revenue60d: Math.round(payments.reduce((a, p) => a + p.amount, 0) * 100) / 100,
        expenses60d: Math.round(expenses.reduce((a, e) => a + e.amount, 0) * 100) / 100,
        vouchersSold60d: vouchersSold.length,
        vouchersRevenue60d: Math.round(vouchersSold.reduce((a, v) => a + v.price, 0) * 100) / 100,
      },
    });
  } catch (e) {
    return serverError(e);
  }
});
