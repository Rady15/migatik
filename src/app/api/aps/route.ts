import { NextRequest, NextResponse } from "next/server";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict } from "@/lib/tenancy";
import { db } from "@/lib/db";

/** GET /api/aps — List all access points with stats. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const periodDays = Math.max(1, Math.min(365, parseInt(req.nextUrl.searchParams.get("period") ?? "7", 10) || 7));

    // Get unique AP names from networkDevice
    const where: any = { accessPoint: { not: null, not: "" } };
    if (routerId) where.routerId = routerId;

    const devices = await db.networkDevice.findMany({
      where,
      select: { accessPoint: true, routerId: true, organizationId: true },
      distinct: ["accessPoint", "routerId"],
    });

    const aps = await Promise.all(
      devices.map(async (d) => {
        const apName = d.accessPoint!;
        const [clientCount, traffic, router] = await Promise.all([
          db.networkDevice.count({ where: { routerId: d.routerId, accessPoint: apName } }),
          db.trafficAggregate.findMany({
            where: { organizationId: d.organizationId, entityType: "ap", entityId: apName },
            orderBy: { day: "desc" },
            take: periodDays,
          }),
          db.router.findUnique({ where: { id: d.routerId }, select: { name: true, host: true, status: true } }),
        ]);

        const totalDown = traffic.reduce((s, t) => s + t.downMb, 0);
        const totalUp = traffic.reduce((s, t) => s + t.upMb, 0);

        // Get sample device for manufacturer info
        const sampleDevice = await db.networkDevice.findFirst({
          where: { routerId: d.routerId, accessPoint: apName },
          select: { manufacturer: true, connectionType: true },
        });

        return {
          name: apName,
          routerId: d.routerId,
          routerName: router?.name,
          routerHost: router?.host,
          routerStatus: router?.status,
          clientCount,
          totalDownloadMb: totalDown,
          totalUploadMb: totalUp,
          totalConsumptionGb: Number(((totalDown + totalUp) / 1024).toFixed(3)),
          manufacturer: sampleDevice?.manufacturer,
          connectionType: sampleDevice?.connectionType,
          trafficDays: traffic.length,
        };
      })
    );

    return NextResponse.json({ aps });
  } catch (e) {
    return serverError(e);
  }
});