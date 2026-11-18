import { NextRequest, NextResponse } from "next/server";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { db } from "@/lib/db";

/** GET /api/aps/[id] — AP detail with clients, traffic, history. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const apName = await routeId(req);
    const routerId = req.nextUrl.searchParams.get("routerId");
    const periodDays = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("period") ?? "30", 10) || 30));

    if (!routerId) return badRequest("routerId مطلوب");

    const router = await db.router.findUnique({ where: { id: routerId }, select: { name: true, host: true, status: true, organizationId: true } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });

    // Clients connected to this AP
    const clients = await db.networkDevice.findMany({
      where: { routerId, accessPoint: apName },
      orderBy: { lastSeen: "desc" },
      select: {
        id: true, macAddress: true, ipAddress: true, hostname: true, customName: true,
        manufacturer: true, connectionType: true, status: true, lastSeen: true, lastActive: true,
        vlanId: true, deviceCategory: true, isNew: true,
      },
    });

    // Traffic history
    const traffic = await db.trafficAggregate.findMany({
      where: { organizationId: router.organizationId, entityType: "ap", entityId: apName },
      orderBy: { day: "desc" },
      take: periodDays,
    });

    // Device stats for charts
    const deviceStats = await db.networkDevice.findMany({
      where: { routerId, accessPoint: apName },
      select: { status: true, connectionType: true, manufacturer: true },
    });

    const statusCounts = deviceStats.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const connTypeCounts = deviceStats.reduce((acc, d) => {
      acc[d.connectionType] = (acc[d.connectionType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const manufacturerCounts = deviceStats.reduce((acc, d) => {
      if (d.manufacturer) acc[d.manufacturer] = (acc[d.manufacturer] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Calculate totals
    const totalDownload = traffic.reduce((s, t) => s + t.downMb, 0);
    const totalUpload = traffic.reduce((s, t) => s + t.upMb, 0);

    return NextResponse.json({
      ap: {
        name: apName,
        routerId,
        routerName: router.name,
        routerHost: router.host,
        routerStatus: router.status,
      },
      clients,
      traffic: traffic.map((t) => ({ day: t.day, downMb: t.downMb, upMb: t.upMb })).reverse(),
      totals: {
        totalDownloadMb: totalDownload,
        totalUploadMb: totalUpload,
        totalConsumptionGb: Number(((totalDownload + totalUpload) / 1024).toFixed(3)),
        clientCount: clients.length,
        onlineClients: clients.filter((c) => c.status === "online").length,
        idleClients: clients.filter((c) => c.status === "idle").length,
        offlineClients: clients.filter((c) => ["offline", "blocked"].includes(c.status)).length,
      },
      charts: {
        trafficDays: traffic.length,
        statusDistribution: statusCounts,
        connectionTypeDistribution: connTypeCounts,
        topManufacturers: Object.entries(manufacturerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
      },
    });
  } catch (e) {
    return serverError(e);
  }
});