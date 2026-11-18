import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { getAreaTraffic, getTopConsumingAreas } from "@/lib/traffic/aggregation";

/** GET /api/traffic/areas?period=30&top=1 — Area daily traffic for period, or top consumers. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const periodDays = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("period") ?? "30", 10) || 30));
    const topOnly = req.nextUrl.searchParams.get("top") === "1";

    if (topOnly) {
      const areas = await getTopConsumingAreas(periodDays);
      return NextResponse.json({ periodDays, areas, summary: computeSummary(areas) });
    }

    const data = await getAreaTraffic(periodDays);

    // Group by Area
    const byArea = new Map<string, { entityId: string; day: string; downMb: number; upMb: number }[]>();
    for (const d of data) {
      const arr = byArea.get(d.entityId) ?? [];
      arr.push({ entityId: d.entityId, day: d.day, downMb: d.downMb, upMb: d.upMb });
      byArea.set(d.entityId, arr);
    }

    const areas = [...byArea.entries()].map(([area, days]) => ({
      area,
      days: days.map((d) => ({ day: d.day, downMb: d.downMb, upMb: d.upMb })),
      totalDownMb: days.reduce((s, x) => s + x.downMb, 0),
      totalUpMb: days.reduce((s, x) => s + x.upMb, 0),
      avgDailyDownMb: days.length ? Number((days.reduce((s, x) => s + x.downMb, 0) / days.length).toFixed(2)) : 0,
      avgDailyUpMb: days.length ? Number((days.reduce((s, x) => s + x.upMb, 0) / days.length).toFixed(2)) : 0,
    }));

    return NextResponse.json({ periodDays, areas, summary: computeSummary(areas) });
  } catch (e) {
    return serverError(e);
  }
});

function computeSummary(areas: any[]) {
  const totalGb = areas.reduce((s, a) => s + (a.totalGb ?? ((a.totalDownMb + a.totalUpMb) / 1024)), 0);
  const sorted = [...areas].sort((a, b) => ((b.totalDownMb + b.totalUpMb) - (a.totalDownMb + a.totalUpMb)));
  return {
    totalAreas: areas.length,
    totalConsumptionGb: Number(totalGb.toFixed(2)),
    topArea: sorted[0]?.area ?? null,
    bottomArea: sorted[sorted.length - 1]?.area ?? null,
    avgAreaGb: areas.length ? Number((totalGb / areas.length).toFixed(2)) : 0,
    percentiles: {
      p50: sorted[Math.floor(sorted.length * 0.5)]?.area ?? null,
      p90: sorted[Math.floor(sorted.length * 0.9)]?.area ?? null,
    },
  };
}