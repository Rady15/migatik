import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { getRouterTraffic } from "@/lib/traffic/aggregation";

/** GET /api/traffic/routers?period=30 — Router daily traffic for period. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const periodDays = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("period") ?? "30", 10) || 30));
    const data = await getRouterTraffic(periodDays);

    // Group by Router
    const byRouter = new Map<string, { entityId: string; day: string; downMb: number; upMb: number }[]>();
    for (const d of data) {
      const arr = byRouter.get(d.entityId) ?? [];
      arr.push({ entityId: d.entityId, day: d.day, downMb: d.downMb, upMb: d.upMb });
      byRouter.set(d.entityId, arr);
    }

    const routers = [...byRouter.entries()].map(([routerId, days]) => ({
      routerId,
      days: days.map((d) => ({ day: d.day, downMb: d.downMb, upMb: d.upMb })),
      totalDownMb: days.reduce((s, x) => s + x.downMb, 0),
      totalUpMb: days.reduce((s, x) => s + x.upMb, 0),
      avgDailyDownMb: days.length ? Number((days.reduce((s, x) => s + x.downMb, 0) / days.length).toFixed(2)) : 0,
      avgDailyUpMb: days.length ? Number((days.reduce((s, x) => s + x.upMb, 0) / days.length).toFixed(2)) : 0,
    }));

    return NextResponse.json({ periodDays, routers });
  } catch (e) {
    return serverError(e);
  }
});