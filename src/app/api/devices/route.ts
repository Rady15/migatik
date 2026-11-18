import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";

/** GET /api/devices — unified device inventory with filters, stats, and export. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const sp = req.nextUrl.searchParams;
    const format = sp.get("format"); // csv | xls | null
    const stats = sp.get("stats") === "1";
    const routerId = sp.get("routerId") && sp.get("routerId") !== "all" ? sp.get("routerId")! : null;
    const search = (sp.get("search") ?? "").trim().toLowerCase();
    const status = sp.get("status") ?? "";
    const connectionType = sp.get("connectionType") ?? "";
    const source = sp.get("source") ?? ""; // dhcp|arp|bridge|wireless|wifi|capsman|hotspot|pppoe
    const iface = sp.get("interface") ?? "";
    const vlan = sp.get("vlan") ?? "";
    const ap = sp.get("ap") ?? "";
    const trust = sp.get("trust") ?? "";
    const isNew = sp.get("isNew") === "1";
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(5, parseInt(sp.get("pageSize") ?? "25", 10) || 25));
    const sort = sp.get("sort") ?? "lastSeen";
    const dir = sp.get("dir") === "asc" ? "asc" : "desc";

    if (stats) return NextResponse.json(await buildStats(routerId));

    const where: Record<string, unknown> = {};
    if (routerId) where.routerId = routerId;
    if (status) where.status = status;
    if (connectionType) where.connectionType = connectionType;
    if (iface) where.interfaceName = iface;
    if (ap) where.accessPoint = ap;
    if (trust) where.trustStatus = trust;
    if (isNew) where.isNew = true;
    if (vlan) where.vlanId = parseInt(vlan, 10) || undefined;
    if (search) {
      where.OR = [
        { macAddress: { contains: search } },
        { ipAddress: { contains: search } },
        { hostname: { contains: search } },
        { customName: { contains: search } },
        { manufacturer: { contains: search } },
      ];
    }
    if (source) {
      // devices seen by a specific discovery source (sources stored as JSON array)
      const rows = await db.networkDevice.findMany({
        where: routerId ? { routerId } : {},
        select: { id: true, sources: true },
      });
      const ids = rows.filter((r) => {
        try { return (JSON.parse(r.sources) as string[]).includes(source); } catch { return false; }
      }).map((r) => r.id);
      where.id = { in: ids };
    }

    const sortField = (["lastSeen", "firstSeen", "macAddress", "ipAddress", "hostname", "status"].includes(sort) ? sort : "lastSeen") as
      "lastSeen" | "firstSeen" | "macAddress" | "ipAddress" | "hostname" | "status";

    if (format) {
      const all = await db.networkDevice.findMany({
        where, orderBy: { [sortField]: dir },
        include: { router: { select: { name: true } } },
      });
      const header = ["Status", "Device", "IP", "MAC", "Manufacturer", "Type", "Connection", "Interface", "VLAN", "AP", "Router", "First Seen", "Last Seen"];
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [header.map(esc).join(","), ...all.map((d) => [
        d.status, d.customName || d.hostname || "-", d.ipAddress ?? "-", d.macAddress, d.manufacturer ?? "-",
        d.deviceCategory, d.connectionType, d.interfaceName ?? "-", d.vlanId ?? "-", d.accessPoint ?? "-",
        d.router.name, d.firstSeen.toISOString(), d.lastSeen?.toISOString() ?? "-",
      ].map(esc).join(","))];
      const csv = "\uFEFF" + lines.join("\r\n");
      if (format === "xls") {
        const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"/></head><body><table border="1"><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr>${all.map((d) => `<tr>${[
          d.status, d.customName || d.hostname || "-", d.ipAddress ?? "-", d.macAddress, d.manufacturer ?? "-",
          d.deviceCategory, d.connectionType, d.interfaceName ?? "-", d.vlanId ?? "-", d.accessPoint ?? "-",
          d.router.name, d.firstSeen.toISOString(), d.lastSeen?.toISOString() ?? "-",
        ].map((v) => `<td>${String(v).replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join("")}</table></body></html>`;
        return new NextResponse(html, {
          headers: {
            "Content-Type": "application/vnd.ms-excel; charset=utf-8",
            "Content-Disposition": `attachment; filename="devices-${Date.now()}.xls"`,
          },
        });
      }
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="devices-${Date.now()}.csv"`,
        },
      });
    }

    const [total, devices] = await Promise.all([
      db.networkDevice.count({ where }),
      db.networkDevice.findMany({
        where,
        orderBy: { [sortField]: dir },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { router: { select: { id: true, name: true, status: true, lastSyncAt: true, lastSyncOk: true, isDemo: true } } },
      }),
    ]);

    return NextResponse.json({
      total, page, pageSize,
      devices: devices.map((d) => ({
        id: d.id,
        mac: d.macAddress,
        ip: d.ipAddress,
        hostname: d.hostname,
        customName: d.customName,
        manufacturer: d.manufacturer,
        category: d.deviceCategory,
        os: d.operatingSystem,
        connectionType: d.connectionType,
        interface: d.interfaceName,
        vlan: d.vlanId,
        ap: d.accessPoint,
        status: d.status,
        trustStatus: d.trustStatus,
        sources: JSON.parse(d.sources || "[]"),
        isNew: d.isNew,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
        lastActive: d.lastActive,
        comment: d.comment,
        router: d.router,
      })),
    });
  } catch (e) {
    return serverError(e);
  }
});

async function buildStats(routerId: string | null) {
  const where = routerId ? { routerId } : {};
  const devices = await db.networkDevice.findMany({ where, select: { status: true, connectionType: true, routerId: true, vlanId: true, firstSeen: true, trustStatus: true, manufacturer: true, accessPoint: true } });
  const kpi = {
    total: devices.length,
    online: 0, offline: 0, idle: 0, unknown: 0, blocked: 0,
    wireless: 0, wired: 0, hotspot: 0, pppoe: 0,
    newDevices: 0, blockedDevices: 0,
  };
  const byRouter: Record<string, number> = {};
  const byVlan: Record<string, number> = {};
  const byAp: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byManufacturer: Record<string, number> = {};
  const dayAgo = Date.now() - 86400_000;
  for (const d of devices) {
    if (d.status === "online") kpi.online++;
    else if (d.status === "offline") kpi.offline++;
    else if (d.status === "idle") kpi.idle++;
    else if (d.status === "blocked") kpi.blocked++;
    else kpi.unknown++;
    if (d.connectionType === "wireless") kpi.wireless++;
    else if (d.connectionType === "wired") kpi.wired++;
    else if (d.connectionType === "hotspot") kpi.hotspot++;
    else if (d.connectionType === "pppoe") kpi.pppoe++;
    if (d.trustStatus === "blocked") kpi.blockedDevices++;
    if (d.firstSeen.getTime() > dayAgo) kpi.newDevices++;
    byRouter[d.routerId] = (byRouter[d.routerId] ?? 0) + 1;
    if (d.vlanId) byVlan[String(d.vlanId)] = (byVlan[String(d.vlanId)] ?? 0) + 1;
    if (d.accessPoint) byAp[d.accessPoint] = (byAp[d.accessPoint] ?? 0) + 1;
    byType[d.connectionType] = (byType[d.connectionType] ?? 0) + 1;
    if (d.manufacturer) byManufacturer[d.manufacturer] = (byManufacturer[d.manufacturer] ?? 0) + 1;
  }

  // online-over-time from hourly snapshot buckets (24h)
  const snapshots = await db.deviceStatsSnapshot.findMany({
    where: { ...(routerId ? { routerId } : {}), ts: { gte: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { ts: "asc" },
  });
  const byTs = new Map<string, { ts: string; online: number; offline: number; total: number }>();
  for (const s of snapshots) {
    const key = s.ts.toISOString().slice(0, 13);
    byTs.set(key, { ts: s.ts.toISOString(), online: s.online, offline: s.offline + s.idle + s.unknown, total: s.total });
  }

  // discovery history: new devices per day (14 days)
  const discoveryHist = await db.networkDevice.findMany({
    where: { ...(routerId ? { routerId } : {}), firstSeen: { gte: new Date(Date.now() - 14 * 86400_000) } },
    select: { firstSeen: true },
  });
  const perDay: Record<string, number> = {};
  for (const d of discoveryHist) {
    const day = d.firstSeen.toISOString().slice(0, 10);
    perDay[day] = (perDay[day] ?? 0) + 1;
  }

  const routers = await db.router.findMany({
    where: { isDemo: false },
    select: { id: true, name: true, status: true, lastSyncAt: true, lastSyncOk: true, syncEnabled: true, syncIntervalSec: true, lastSyncError: true, isDemo: true },
  });

  return {
    kpi,
    onlineOverTime: [...byTs.values()],
    byRouter: Object.entries(byRouter).map(([id, count]) => ({ id, count })),
    byVlan: Object.entries(byVlan).map(([vlan, count]) => ({ vlan, count })),
    byAp: Object.entries(byAp).map(([ap, count]) => ({ ap, count })),
    byType: Object.entries(byType).map(([type, count]) => ({ type, count })),
    byManufacturer: Object.entries(byManufacturer).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, count]) => ({ manufacturer: m, count })),
    newPerDay: Object.entries(perDay).sort().map(([day, count]) => ({ day, count })),
    routers,
  };
}
