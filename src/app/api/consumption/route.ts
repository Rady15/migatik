import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { readHotspotLive } from "@/lib/hotspot-live";

/**
 * GET /api/consumption?routerId=<id|all>
 *
 * One response with BOTH current and all-time usage for every device and every
 * hotspot user:
 *  - current  = the live RouterOS counters for the open session / host entry
 *               (bytes-in / bytes-out + uptime), plus the last sampled Mbps.
 *  - total    = DeviceTrafficDaily (downMb/upMb) for devices and the router's
 *               cumulative HotspotUser.dataUsedMb for users.
 * Nothing is invented: a device with no live entry reports 0 current usage and
 * a user with no router counter reports 0 total.
 */

export interface ConsumptionDevice {
  id: string;
  name: string;
  mac: string;
  ip: string | null;
  routerId: string;
  routerName: string;
  status: string;
  connectionType: string;
  currentDownMb: number;
  currentUpMb: number;
  currentSec: number;
  currentKind: "hotspot" | "host" | null;
  rateDownMbps: number;
  rateUpMbps: number;
  rateAt: string | null;
  totalDownMb: number;
  totalUpMb: number;
  totalMb: number;
}

export interface ConsumptionUser {
  id: string;
  username: string;
  fullName: string | null;
  phone: string | null;
  routerId: string | null;
  routerName: string;
  status: string;
  profile: string;
  packageName: string | null;
  dataLimitMb: number | null;
  currentDownMb: number;
  currentUpMb: number;
  currentSec: number;
  active: boolean;
  totalMb: number;
}

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const sp = req.nextUrl.searchParams;
    const routerId = sp.get("routerId") && sp.get("routerId") !== "all" ? sp.get("routerId")! : null;
    const where = routerId ? { routerId } : {};

    const [devices, users, routers] = await Promise.all([
      db.networkDevice.findMany({
        where,
        select: {
          id: true, macAddress: true, ipAddress: true, hostname: true, customName: true,
          status: true, connectionType: true, routerId: true,
          router: { select: { name: true } },
        },
        orderBy: { lastSeen: "desc" },
        take: 1000,
      }),
      db.hotspotUser.findMany({
        where,
        select: {
          id: true, username: true, fullName: true, phone: true, status: true,
          profile: true, dataUsedMb: true, routerId: true,
          router: { select: { name: true } },
          package: { select: { name: true, dataLimitMb: true } },
        },
        orderBy: { username: "asc" },
        take: 1000,
      }),
      db.router.findMany({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
    ]);

    const deviceIds = devices.map((d) => d.id);
    const [dailyRows, sampleRows, live] = await Promise.all([
      deviceIds.length
        ? db.deviceTrafficDaily.findMany({
            where: { deviceId: { in: deviceIds } },
            select: { deviceId: true, downMb: true, upMb: true },
            take: 100000,
          })
        : Promise.resolve([] as { deviceId: string; downMb: number; upMb: number }[]),
      deviceIds.length
        ? db.deviceTrafficSample.findMany({
            where: { deviceId: { in: deviceIds } },
            orderBy: { ts: "desc" },
            take: 5000,
            select: { deviceId: true, rxMbps: true, txMbps: true, ts: true },
          })
        : Promise.resolve([]),
      readHotspotLive(routerId ? [routerId] : undefined),
    ]);

    const daily = new Map<string, { downMb: number; upMb: number }>();
    for (const r of dailyRows) {
      const c = daily.get(r.deviceId) ?? { downMb: 0, upMb: 0 };
      c.downMb += r.downMb;
      c.upMb += r.upMb;
      daily.set(r.deviceId, c);
    }
    const latestSample = new Map<string, { rxMbps: number; txMbps: number; ts: Date }>();
    for (const s of sampleRows) {
      if (!latestSample.has(s.deviceId)) latestSample.set(s.deviceId, s);
    }

    const activeByMac = new Map<string, (typeof live.active)[number]>();
    const activeByUser = new Map<string, (typeof live.active)[number]>();
    for (const a of live.active) {
      if (a.mac) activeByMac.set(a.mac.toLowerCase(), a);
      activeByUser.set(a.user.toLowerCase(), a);
    }
    const hostByMac = new Map<string, (typeof live.hosts)[number]>();
    for (const h of live.hosts) hostByMac.set(h.mac.toLowerCase(), h);

    const routerNames = new Map(routers.map((r) => [r.id, r.name]));

    const deviceRows: ConsumptionDevice[] = devices.map((d) => {
      const mac = d.macAddress.toLowerCase();
      const liveRow = activeByMac.get(mac);
      const hostRow = liveRow ? undefined : hostByMac.get(mac);
      const current = liveRow ?? hostRow;
      const totals = daily.get(d.id);
      const sample = latestSample.get(d.id);
      const totalDownMb = totals?.downMb ?? 0;
      const totalUpMb = totals?.upMb ?? 0;
      return {
        id: d.id,
        name: d.customName || d.hostname || d.macAddress,
        mac: d.macAddress,
        ip: d.ipAddress,
        routerId: d.routerId,
        routerName: d.router?.name ?? routerNames.get(d.routerId) ?? "—",
        status: d.status,
        connectionType: d.connectionType,
        currentDownMb: current?.bytesIn ?? 0,
        currentUpMb: current?.bytesOut ?? 0,
        currentSec: current?.durationSec ?? 0,
        currentKind: liveRow ? "hotspot" : hostRow ? "host" : null,
        rateDownMbps: sample?.rxMbps ?? 0,
        rateUpMbps: sample?.txMbps ?? 0,
        rateAt: sample?.ts.toISOString() ?? null,
        totalDownMb,
        totalUpMb,
        totalMb: totalDownMb + totalUpMb,
      };
    });

    const userRows: ConsumptionUser[] = users.map((u) => {
      const liveRow = activeByUser.get(u.username.toLowerCase());
      return {
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        phone: u.phone,
        routerId: u.routerId,
        routerName: u.router?.name ?? (u.routerId ? routerNames.get(u.routerId) ?? "—" : "—"),
        status: u.status,
        profile: u.profile,
        packageName: u.package?.name ?? null,
        dataLimitMb: u.package?.dataLimitMb ?? null,
        currentDownMb: liveRow?.bytesIn ?? 0,
        currentUpMb: liveRow?.bytesOut ?? 0,
        currentSec: liveRow?.durationSec ?? 0,
        active: Boolean(liveRow),
        totalMb: u.dataUsedMb ?? 0,
      };
    });

    const totals = {
      devices: deviceRows.length,
      users: userRows.length,
      onlineDevices: deviceRows.filter((d) => d.status === "online").length,
      activeSessions: userRows.filter((u) => u.active).length,
      currentDownMb: deviceRows.reduce((a, d) => a + d.currentDownMb, 0),
      currentUpMb: deviceRows.reduce((a, d) => a + d.currentUpMb, 0),
      totalDownMb: deviceRows.reduce((a, d) => a + d.totalDownMb, 0),
      totalUpMb: deviceRows.reduce((a, d) => a + d.totalUpMb, 0),
      userTotalMb: userRows.reduce((a, u) => a + u.totalMb, 0),
    };

    return NextResponse.json(
      { devices: deviceRows, users: userRows, totals, errors: live.errors, fetchedAt: live.fetchedAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return serverError(e);
  }
});
