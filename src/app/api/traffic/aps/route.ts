import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { getApTraffic } from "@/lib/traffic/aggregation";

/** GET /api/traffic/aps?period=7&routerId=... — AP daily traffic for period. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const periodDays = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("period") ?? "7", 10) || 7));
    const data = await getApTraffic(periodDays);

    // Group by AP
    const byAp = new Map<string, { entityId: string; day: string; downMb: number; upMb: number }[]>();
    for (const d of data) {
      const arr = byAp.get(d.entityId) ?? [];
      arr.push({ entityId: d.entityId, day: d.day, downMb: d.downMb, upMb: d.upMb });
      byAp.set(d.entityId, arr);
    }

    return NextResponse.json({
      periodDays,
      aps: [...byAp.entries()].map(([ap, days]) => ({
        ap,
        days: days.map((d) => ({ day: d.day, downMb: d.downMb, upMb: d.upMb })),
        totalDownMb: days.reduce((s, x) => s + x.downMb, 0),
        totalUpMb: days.reduce((s, x) => s + x.upMb, 0),
        avgDailyDownMb: days.length ? Number((days.reduce((s, x) => s + x.downMb, 0) / days.length).toFixed(2)) : 0,
        avgDailyUpMb: days.length ? Number((days.reduce((s, x) => s + x.upMb, 0) / days.length).toFixed(2)) : 0,
      })),
    });
  } catch (e) {
    return serverError(e);
  }
});