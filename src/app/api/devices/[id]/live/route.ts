import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) {
    const resolved = await p;
    if (resolved.id) return resolved.id;
  }
  // Fallback: extract from URL path /api/devices/<id>/live
  const parts = req.nextUrl.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("devices");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return "";
}

/** GET /api/devices/[id]/live?minutes=10 — recent traffic samples for the live chart. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const minutes = Math.min(120, Math.max(2, parseInt(req.nextUrl.searchParams.get("minutes") ?? "15", 10) || 15));
    const since = new Date(Date.now() - minutes * 60_000);
    const [samples, daily, monthly, device] = await Promise.all([
      db.deviceTrafficSample.findMany({ where: { deviceId: id, ts: { gte: since } }, orderBy: { ts: "asc" } }),
      db.deviceTrafficDaily.findMany({ where: { deviceId: id }, orderBy: { day: "desc" }, take: 30 }),
      db.deviceTrafficDaily.findMany({ where: { deviceId: id }, orderBy: { day: "asc" }, take: 365 }),
      db.networkDevice.findFirst({ where: { id }, select: { id: true, macAddress: true, ipAddress: true, customName: true, hostname: true, status: true, connectionType: true } }),
    ]);
    if (!device) return NextResponse.json({ error: "الجهاز غير موجود" }, { status: 404 });

    // monthly aggregation from daily rows
    const monthlyMap = new Map<string, { downMb: number; upMb: number }>();
    for (const d of daily) {
      const m = d.day.slice(0, 7);
      const cur = monthlyMap.get(m) ?? { downMb: 0, upMb: 0 };
      cur.downMb += d.downMb;
      cur.upMb += d.upMb;
      monthlyMap.set(m, cur);
    }
    // top consumers among currently-online devices for comparison
    const topDevices = await db.deviceTrafficSample.findMany({
      where: { ts: { gte: new Date(Date.now() - 300_000) } },
      orderBy: { ts: "desc" },
    });
    const totals = new Map<string, number>();
    for (const s of topDevices) totals.set(s.deviceId, (totals.get(s.deviceId) ?? 0) + s.rxMbps + s.txMbps);
    const topIds = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x]) => x);
    const topDevicesInfo = topIds.length
      ? await db.networkDevice.findMany({ where: { id: { in: topIds } }, select: { id: true, customName: true, hostname: true, macAddress: true, ipAddress: true, status: true } })
      : [];

    return NextResponse.json({
      device,
      samples,
      daily: daily.reverse(),
      monthly: [...monthlyMap.entries()].sort().map(([month, v]) => ({ month, ...v })),
      topConsumers: topIds.map((tid) => {
        const info = topDevicesInfo.find((t) => t.id === tid);
        const label = info ? (info.customName || info.hostname || info.ipAddress || info.macAddress) : tid;
        return { deviceId: tid, label, totalMbps: Number((totals.get(tid) ?? 0).toFixed(2)) };
      }),
    });
  } catch (e) {
    return serverError(e);
  }
});
