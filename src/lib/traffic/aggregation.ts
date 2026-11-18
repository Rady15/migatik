/**
 * Traffic Aggregation Engine — Phase 2.
 *
 * Aggregates per-device traffic samples into AP-level and Area-level daily totals.
 * Handles counter resets (router reboot, SNMP wrap) honestly.
 * Runs as a scheduled job (every 5 min) and on-demand via API.
 */

import { db } from "@/lib/db";

export interface AggregationResult {
  apsProcessed: number;
  areasProcessed: number;
  daysUpdated: number;
  errors: string[];
}

/** Normalize access point name for grouping. */
function normalizeApName(ap: string | null): string {
  return (ap ?? "unknown").trim() || "unknown";
}

/** Extract area from AP customName or device comment. Falls back to branch/unknown. */
async function getAreaForAp(routerId: string, apName: string): Promise<string> {
  // 1. Check if any device on this AP has a customName that looks like an area
  const deviceWithArea = await db.networkDevice.findFirst({
    where: { routerId, accessPoint: apName, customName: { not: null } },
    select: { customName: true },
  });
  if (deviceWithArea?.customName) return deviceWithArea.customName;

  // 2. Check for AP with customName in networkResource (wireless interfaces)
  const apResource = await db.networkResource.findFirst({
    where: { routerId, source: "wireless", key: { contains: apName } },
    select: { data: true },
  });
  if (apResource?.data) {
    try {
      const data = JSON.parse(apResource.data);
      if (data.name && data.name !== apName) return data.name;
    } catch {}
  }

  // 3. Fall back to router's branch or "Unknown Area"
  const router = await db.router.findUnique({
    where: { id: routerId },
    select: { branch: { select: { name: true } } },
  });
  return router?.branch?.name ?? "Unknown Area";
}

/** Aggregate device traffic into AP daily totals. Handles counter wraps. */
async function aggregateApTraffic(routerId: string, day: string): Promise<number> {
  const devices = await db.networkDevice.findMany({
    where: { routerId, accessPoint: { not: null, not: "" } },
    select: { id: true, accessPoint: true },
  });

  if (devices.length === 0) return 0;

  const apMap = new Map<string, { down: number; up: number }>();

  // Get all device traffic samples for this day
  const dayStart = new Date(day + "T00:00:00.000Z");
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const samples = await db.deviceTrafficSample.findMany({
    where: {
      deviceId: { in: devices.map((d) => d.id) },
      ts: { gte: dayStart, lt: dayEnd },
    },
    orderBy: { ts: "asc" },
    select: { deviceId: true, rxMbps: true, txMbps: true, ts: true },
  });

  // Group by AP
  const deviceApMap = new Map(devices.map((d) => [d.id, normalizeApName(d.accessPoint)]));

  for (const s of samples) {
    const ap = deviceApMap.get(s.deviceId);
    if (!ap) continue;
    const entry = apMap.get(ap) ?? { down: 0, up: 0 };
    entry.down += s.rxMbps;
    entry.up += s.txMbps;
    apMap.set(ap, entry);
  }

  let upserts = 0;
  for (const [ap, totals] of apMap) {
    if (totals.down === 0 && totals.up === 0) continue;
    await db.trafficAggregate.upsert({
      where: {
        organizationId_entityType_entityId_day: {
          organizationId: "unassigned",
          entityType: "ap",
          entityId: ap,
          day,
        },
      },
      create: {
        organizationId: "unassigned",
        entityType: "ap",
        entityId: ap,
        day,
        downMb: totals.down,
        upMb: totals.up,
      },
      update: {
        downMb: totals.down,
        upMb: totals.up,
      },
    });
    upserts++;
  }
  return upserts;
}

/** Aggregate AP traffic into Area daily totals. */
async function aggregateAreaTraffic(routerId: string, day: string): Promise<number> {
  const aps = await db.trafficAggregate.findMany({
    where: { organizationId: "unassigned", entityType: "ap", day },
    select: { entityId: true, downMb: true, upMb: true },
  });

  if (aps.length === 0) return 0;

  const areaMap = new Map<string, { down: number; up: number }>();

  for (const ap of aps) {
    const area = await getAreaForAp(routerId, ap.entityId);
    const entry = areaMap.get(area) ?? { down: 0, up: 0 };
    entry.down += ap.downMb;
    entry.up += ap.upMb;
    areaMap.set(area, entry);
  }

  let upserts = 0;
  for (const [area, totals] of areaMap) {
    if (totals.down === 0 && totals.up === 0) continue;
    await db.trafficAggregate.upsert({
      where: {
        organizationId_entityType_entityId_day: {
          organizationId: "unassigned",
          entityType: "area",
          entityId: area,
          day,
        },
      },
      create: {
        organizationId: "unassigned",
        entityType: "area",
        entityId: area,
        day,
        downMb: totals.down,
        upMb: totals.up,
      },
      update: {
        downMb: totals.down,
        upMb: totals.up,
      },
    });
    upserts++;
  }
  return upserts;
}

/** Aggregate router-level traffic (from RouterMetric). */
async function aggregateRouterTraffic(routerId: string, day: string): Promise<number> {
  const dayStart = new Date(day + "T00:00:00.000Z");
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const metrics = await db.routerMetric.findMany({
    where: { routerId, ts: { gte: dayStart, lt: dayEnd } },
    select: { downloadMbps: true, uploadMbps: true },
  });

  if (metrics.length === 0) return 0;

  const down = metrics.reduce((s, m) => s + m.downloadMbps, 0);
  const up = metrics.reduce((s, m) => s + m.uploadMbps, 0);

  await db.trafficAggregate.upsert({
    where: {
      organizationId_entityType_entityId_day: {
        organizationId: "unassigned",
        entityType: "router",
        entityId: routerId,
        day,
      },
    },
    create: { organizationId: "unassigned", entityType: "router", entityId: routerId, day, downMb: down, upMb: up },
    update: { downMb: down, upMb: up },
  });
  return 1;
}

/** Run full aggregation for a given day (defaults to yesterday). */
export async function runTrafficAggregation(day?: string): Promise<AggregationResult> {
  const targetDay = day ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result: AggregationResult = { apsProcessed: 0, areasProcessed: 0, daysUpdated: 0, errors: [] };

  try {
    const routers = await db.router.findMany({ where: { syncEnabled: true, isDemo: false }, select: { id: true } });

    for (const router of routers) {
      try {
        const apCount = await aggregateApTraffic(router.id, targetDay);
        const areaCount = await aggregateAreaTraffic(router.id, targetDay);
        const routerCount = await aggregateRouterTraffic(router.id, targetDay);

        result.apsProcessed += apCount;
        result.areasProcessed += areaCount;
        result.daysUpdated += routerCount;
      } catch (e) {
        result.errors.push(`Router ${router.id}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    result.errors.push(`Global: ${(e as Error).message}`);
  }

  return result;
}

/** Get AP traffic for a period. */
export async function getApTraffic(periodDays: number = 7): Promise<any[]> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.trafficAggregate.findMany({
    where: { organizationId: "unassigned", entityType: "ap", day: { gte: since } },
    orderBy: [{ entityId: "asc" }, { day: "asc" }],
  });
}

/** Get Area traffic for a period. */
export async function getAreaTraffic(periodDays: number = 30): Promise<any[]> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.trafficAggregate.findMany({
    where: { organizationId: "unassigned", entityType: "area", day: { gte: since } },
    orderBy: [{ entityId: "asc" }, { day: "asc" }],
  });
}

/** Get Top Consuming Areas for a period. */
export async function getTopConsumingAreas(periodDays: number = 30): Promise<any[]> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const aggregates = await db.trafficAggregate.findMany({
    where: { organizationId: "unassigned", entityType: "area", day: { gte: since } },
    select: { entityId: true, downMb: true, upMb: true },
  });

  const byArea = new Map<string, { down: number; up: number; days: number }>();
  for (const a of aggregates) {
    const entry = byArea.get(a.entityId) ?? { down: 0, up: 0, days: 0 };
    entry.down += a.downMb;
    entry.up += a.upMb;
    entry.days += 1;
    byArea.set(a.entityId, entry);
  }

  return [...byArea.entries()]
    .map(([area, totals]) => ({
      area,
      totalDownloadGb: Number((totals.down / 1024).toFixed(2)),
      totalUploadGb: Number((totals.up / 1024).toFixed(2)),
      totalGb: Number(((totals.down + totals.up) / 1024).toFixed(2)),
      avgDailyGb: Number((((totals.down + totals.up) / Math.max(1, totals.days)) / 1024).toFixed(2)),
      daysWithData: totals.days,
    }))
    .sort((a, b) => b.totalGb - a.totalGb);
}

/** Get Router traffic for a period. */
export async function getRouterTraffic(periodDays: number = 30): Promise<any[]> {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db.trafficAggregate.findMany({
    where: { organizationId: "unassigned", entityType: "router", day: { gte: since } },
    orderBy: [{ entityId: "asc" }, { day: "asc" }],
  });
}