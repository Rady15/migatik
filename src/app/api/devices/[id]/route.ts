import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

/** GET /api/devices/[id] — full device profile: overview, evidence, history, usage. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const device = await db.networkDevice.findFirst({
      where: { id },
      include: { router: { select: { id: true, name: true, host: true, status: true, lastSyncAt: true, lastSyncOk: true, identity: true, isDemo: true } } },
    });
    if (!device) return NextResponse.json({ error: "الجهاز غير موجود" }, { status: 404 });

    const [events, ipHistory, blockRules, observations, daily, samples, sessionRows] = await Promise.all([
      db.deviceEvent.findMany({ where: { deviceId: id }, orderBy: { ts: "desc" }, take: 100 }),
      db.deviceIpHistory.findMany({ where: { deviceId: id }, orderBy: { lastSeen: "desc" } }),
      db.deviceBlockRule.findMany({ where: { macAddress: device.macAddress, routerId: device.routerId }, orderBy: { createdAt: "desc" } }),
      db.deviceObservation.findMany({ where: { deviceId: id }, orderBy: { seenAt: "desc" }, take: 20 }),
      db.deviceTrafficDaily.findMany({ where: { deviceId: id }, orderBy: { day: "asc" }, take: 90 }),
      db.deviceTrafficSample.findMany({ where: { deviceId: id }, orderBy: { ts: "desc" }, take: 60 }),
      device.connectionType === "hotspot"
        ? db.hotspotSession.findMany({ where: { mac: device.macAddress, routerId: device.routerId }, orderBy: { startedAt: "desc" }, take: 20 })
        : Promise.resolve([]),
    ]);

    // enrich with latest source snapshots (what the router last reported, per source)
    const [lease, arp, bridge, wireless, ppp] = await Promise.all([
      db.dhcpLease.findFirst({ where: { routerId: device.routerId, macAddress: device.macAddress }, orderBy: { seenAt: "desc" } }),
      db.arpEntry.findFirst({ where: { routerId: device.routerId, macAddress: device.macAddress }, orderBy: { seenAt: "desc" } }),
      db.bridgeHost.findFirst({ where: { routerId: device.routerId, macAddress: device.macAddress }, orderBy: { seenAt: "desc" } }),
      db.wirelessClient.findFirst({ where: { routerId: device.routerId, macAddress: device.macAddress }, orderBy: { seenAt: "desc" } }),
      db.pppSession.findFirst({ where: { routerId: device.routerId, callerId: device.macAddress }, orderBy: { seenAt: "desc" } }),
    ]);

    return NextResponse.json({
      device: {
        id: device.id,
        mac: device.macAddress,
        ip: device.ipAddress,
        hostname: device.hostname,
        customName: device.customName,
        manufacturer: device.manufacturer,
        category: device.deviceCategory,
        os: device.operatingSystem,
        connectionType: device.connectionType,
        interface: device.interfaceName,
        vlan: device.vlanId,
        ap: device.accessPoint,
        status: device.status,
        trustStatus: device.trustStatus,
        sources: JSON.parse(device.sources || "[]"),
        sourceDetails: JSON.parse(device.sourceDetails || "{}"),
        isNew: device.isNew,
        firstSeen: device.firstSeen,
        lastSeen: device.lastSeen,
        lastActive: device.lastActive,
        comment: device.comment,
        router: device.router,
      },
      evidence: {
        dhcp: lease, arp, bridge,
        wireless: wireless ? { ...wireless, signal: wireless.signal, ssid: wireless.ssid, band: wireless.band, txRate: wireless.txRate, rxRate: wireless.rxRate, apiPath: wireless.apiPath } : null,
        ppp,
      },
      events,
      ipHistory,
      blockRules,
      observations,
      usage: {
        daily,
        recentSamples: samples.reverse(), // oldest → newest for charting
      },
      sessions: sessionRows,
    });
  } catch (e) {
    return serverError(e);
  }
});
