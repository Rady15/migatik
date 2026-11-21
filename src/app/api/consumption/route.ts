import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { readHotspotLive } from "@/lib/hotspot-live";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";

/**
 * GET /api/consumption?routerId=<id|all>
 *
 * CURRENT  = live RouterOS counters for the open session / host entry + last
 *            sampled rate. These reset when the session ends.
 * TOTAL    = the router's cumulative per-user counters from
 *            /ip/hotspot/user/print (bytes-in / bytes-out / uptime / packets),
 *            matched to the device by its hotspot username (MAC). For devices
 *            without a router user we fall back to the daily sync rollups.
 *
 * All byte values are MiB (÷ 1,048,576), exactly as RouterOS prints them, so
 * the UI must label them MiB/GiB — never MB/GB.
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
  currentDownMib: number;
  currentUpMib: number;
  currentSec: number;
  currentKind: "hotspot" | "host" | null;
  rateDownMbps: number;
  rateUpMbps: number;
  rateAt: string | null;
  totalDownMib: number;
  totalUpMib: number;
  totalMib: number;
  totalSource: "router_user" | "daily_sync";
  trackedDownMib: number;
  trackedUpMib: number;
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
  dataLimitMib: number | null;
  currentDownMib: number;
  currentUpMib: number;
  currentSec: number;
  active: boolean;
  totalDownMib: number;
  totalUpMib: number;
  totalMib: number;
  totalUptimeSec: number;
  packetsIn: number;
  packetsOut: number;
  counterSource: "router" | "db";
}

interface RouterCounter {
  uptimeSec: number;
  downMib: number;
  upMib: number;
  packetsIn: number;
  packetsOut: number;
}

const MIB = 1048576;

function toMib(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round((n / MIB) * 100) / 100 : 0;
}

/** RouterOS uptime is "3d8h49m26s", older builds may print "3d 08:49:26". */
function parseUptime(value?: string): number {
  if (!value) return 0;
  let sec = 0;
  const re = /(\d+)\s*(w|d|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const n = Number(m[1]);
    const mult = m[2] === "w" ? 604800 : m[2] === "d" ? 86400 : m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
    sec += n * mult;
  }
  if (sec > 0) return sec;
  // "08:49:26" / "01:23" — only when no letter-suffixed part was found.
  const parts = value.trim().split(/[\s:]+/).map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  return 0;
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
          profile: true, dataUsedMb: true, uptimeSec: true, routerId: true,
          router: { select: { name: true } },
          package: { select: { name: true, dataLimitMb: true } },
        },
        orderBy: { username: "asc" },
        take: 1000,
      }),
      db.router.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true,
          apiUsername: true, apiPasswordEnc: true, connectionMethod: true, agentId: true,
        },
      }),
    ]);

    const routerList = routerId ? routers.filter((r) => r.id === routerId) : routers;
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
        : Promise.resolve([] as { deviceId: string; rxMbps: number; txMbps: number; ts: Date }[]),
      readHotspotLive(routerId ? [routerId] : undefined),
    ]);

    // Cumulative per-user counters straight from the router (never the stale DB
    // snapshot) so the numbers match what the operator sees in WinBox.
    const counters = new Map<string, RouterCounter>();
    const counterErrors: { router: string; error: string }[] = [];
    await Promise.all(routerList.map(async (router) => {
      const res = await withRouterRow(
        router,
        async (conn) => runCommand(conn, ["/ip/hotspot/user/print"]),
        { connectTimeoutMs: 5000, commandTimeoutMs: 8000 },
      );
      if (!res.ok || !res.value) {
        counterErrors.push({ router: router.name, error: res.error ?? "فشل قراءة عدّادات المستخدمين" });
        return;
      }
      const cmd = res.value;
      if (!cmd.ok) {
        counterErrors.push({ router: router.name, error: cmd.error ?? "فشل قراءة عدّادات المستخدمين" });
        return;
      }
      for (const row of cmd.data) {
        const name = String(row.name ?? "").toLowerCase();
        if (!name) continue;
        counters.set(`${router.id}|${name}`, {
          uptimeSec: parseUptime(row.uptime),
          downMib: toMib(row["bytes-in"]),
          upMib: toMib(row["bytes-out"]),
          packetsIn: Number(row["packets-in"] ?? 0) || 0,
          packetsOut: Number(row["packets-out"] ?? 0) || 0,
        });
      }
    }));

    const daily = new Map<string, { downMib: number; upMib: number }>();
    for (const r of dailyRows) {
      const c = daily.get(r.deviceId) ?? { downMib: 0, upMib: 0 };
      c.downMib += r.downMb;
      c.upMib += r.upMb;
      daily.set(r.deviceId, c);
    }
    const latestSample = new Map<string, { rxMbps: number; txMbps: number; ts: Date }>();
    for (const s of sampleRows) {
      if (!latestSample.has(s.deviceId)) latestSample.set(s.deviceId, s);
    }

    const activeByMac = new Map<string, (typeof live.active)[number]>();
    for (const a of live.active) {
      if (a.mac) activeByMac.set(a.mac.toLowerCase(), a);
    }
    const hostByMac = new Map<string, (typeof live.hosts)[number]>();
    for (const h of live.hosts) hostByMac.set(h.mac.toLowerCase(), h);

    const routerNames = new Map(routers.map((r) => [r.id, r.name]));

    const userRows: ConsumptionUser[] = users.map((u) => {
      const liveRow = live.active.find((a) =>
        a.routerId === u.routerId && a.user.toLowerCase() === u.username.toLowerCase());
      const counter = counters.get(`${u.routerId}|${u.username.toLowerCase()}`);
      const fromRouter = Boolean(counter);
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
        dataLimitMib: u.package?.dataLimitMb ?? null,
        currentDownMib: liveRow?.bytesIn ?? 0,
        currentUpMib: liveRow?.bytesOut ?? 0,
        currentSec: liveRow?.durationSec ?? 0,
        active: Boolean(liveRow),
        totalDownMib: counter?.downMib ?? 0,
        totalUpMib: counter?.upMib ?? 0,
        totalMib: fromRouter ? counter!.downMib + counter!.upMib : (u.dataUsedMb ?? 0),
        totalUptimeSec: counter?.uptimeSec ?? u.uptimeSec ?? 0,
        packetsIn: counter?.packetsIn ?? 0,
        packetsOut: counter?.packetsOut ?? 0,
        counterSource: fromRouter ? "router" : "db",
      };
    });

    const userByRouterName = new Map(userRows.map((u) => [`${u.routerId}|${u.username.toLowerCase()}`, u]));

    const deviceRows: ConsumptionDevice[] = devices.map((d) => {
      const mac = d.macAddress.toLowerCase();
      const activeRow = activeByMac.get(mac);
      const hostRow = activeRow ? undefined : hostByMac.get(mac);
      const current = activeRow ?? hostRow;
      const tracked = daily.get(d.id) ?? { downMib: 0, upMib: 0 };
      // MAC-login Hotspot users are named after the client MAC, so the router's
      // cumulative counters for that user ARE the device's all-time usage.
      const linked = userByRouterName.get(`${d.routerId}|${activeRow?.user.toLowerCase() ?? mac}`);
      const fromRouter = Boolean(linked && linked.counterSource === "router");
      const sample = latestSample.get(d.id);
      const totalDownMib = fromRouter ? linked!.totalDownMib : tracked.downMib;
      const totalUpMib = fromRouter ? linked!.totalUpMib : tracked.upMib;
      return {
        id: d.id,
        name: d.customName || d.hostname || d.macAddress,
        mac: d.macAddress,
        ip: d.ipAddress,
        routerId: d.routerId,
        routerName: d.router?.name ?? routerNames.get(d.routerId) ?? "—",
        status: d.status,
        connectionType: d.connectionType,
        currentDownMib: current?.bytesIn ?? 0,
        currentUpMib: current?.bytesOut ?? 0,
        currentSec: current?.durationSec ?? 0,
        currentKind: activeRow ? "hotspot" : hostRow ? "host" : null,
        rateDownMbps: sample?.rxMbps ?? 0,
        rateUpMbps: sample?.txMbps ?? 0,
        rateAt: sample?.ts.toISOString() ?? null,
        totalDownMib,
        totalUpMib,
        totalMib: totalDownMib + totalUpMib,
        totalSource: fromRouter ? "router_user" : "daily_sync",
        trackedDownMib: tracked.downMib,
        trackedUpMib: tracked.upMib,
      };
    });

    const totals = {
      devices: deviceRows.length,
      users: userRows.length,
      onlineDevices: deviceRows.filter((d) => d.status === "online").length,
      activeSessions: userRows.filter((u) => u.active).length,
      currentDownMib: deviceRows.reduce((a, d) => a + d.currentDownMib, 0),
      currentUpMib: deviceRows.reduce((a, d) => a + d.currentUpMib, 0),
      totalDownMib: deviceRows.reduce((a, d) => a + d.totalDownMib, 0),
      totalUpMib: deviceRows.reduce((a, d) => a + d.totalUpMib, 0),
      userTotalMib: userRows.reduce((a, u) => a + u.totalMib, 0),
    };

    return NextResponse.json(
      {
        devices: deviceRows, users: userRows, totals,
        errors: [...live.errors, ...counterErrors], fetchedAt: live.fetchedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return serverError(e);
  }
});
