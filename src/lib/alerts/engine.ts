/**
 * Alerting Engine — Phase 4.
 *
 * Monitors network health and generates alerts based on configurable rules.
 * Runs as a scheduled job (every 60s) and provides API for querying alerts.
 */

import { db } from "@/lib/db";

export interface AlertRule {
  id: string;
  name: string;
  type: "ap_down" | "router_down" | "traffic_spike" | "packet_loss" | "high_latency" | "device_missing";
  enabled: boolean;
  severity: "info" | "warning" | "critical";
  threshold: {
    // ap_down / router_down
    durationMinutes?: number;
    // traffic_spike
    standardDeviations?: number;
    minDurationMinutes?: number;
    // packet_loss
    maxLossPercent?: number;
    // high_latency
    maxLatencyMs?: number;
    // device_missing
    missingMinutes?: number;
  };
  cooldownMinutes: number;
  notifyChannels: string[]; // "in_app", "email", "webhook"
}

export interface AlertCheckResult {
  alertsCreated: number;
  errors: string[];
}

const DEFAULT_RULES: AlertRule[] = [
  {
    id: "ap_down",
    name: "Access Point Down",
    type: "ap_down",
    enabled: true,
    severity: "critical",
    threshold: { durationMinutes: 5 },
    cooldownMinutes: 15,
    notifyChannels: ["in_app"],
  },
  {
    id: "router_down",
    name: "Router Down",
    type: "router_down",
    enabled: true,
    severity: "critical",
    threshold: { durationMinutes: 2 },
    cooldownMinutes: 10,
    notifyChannels: ["in_app"],
  },
  {
    id: "traffic_spike",
    name: "Traffic Spike",
    type: "traffic_spike",
    enabled: true,
    severity: "warning",
    threshold: { standardDeviations: 3, minDurationMinutes: 10 },
    cooldownMinutes: 30,
    notifyChannels: ["in_app"],
  },
  {
    id: "packet_loss",
    name: "High Packet Loss",
    type: "packet_loss",
    enabled: true,
    severity: "warning",
    threshold: { maxLossPercent: 5 },
    cooldownMinutes: 15,
    notifyChannels: ["in_app"],
  },
  {
    id: "high_latency",
    name: "High Latency",
    type: "high_latency",
    enabled: true,
    severity: "warning",
    threshold: { maxLatencyMs: 200 },
    cooldownMinutes: 15,
    notifyChannels: ["in_app"],
  },
  {
    id: "device_missing",
    name: "Device Missing",
    type: "device_missing",
    enabled: true,
    severity: "info",
    threshold: { missingMinutes: 30 },
    cooldownMinutes: 60,
    notifyChannels: ["in_app"],
  },
];

/** Get active rules from DB or use defaults. */
async function getRules(): Promise<AlertRule[]> {
  try {
    const rows = await db.setting.findMany({
      where: { key: { startsWith: "alert_rule_" } },
    });
    if (rows.length === 0) return DEFAULT_RULES;
    return rows.map((r) => JSON.parse(r.value) as AlertRule);
  } catch {
    return DEFAULT_RULES;
  }
}

/** Check if enough time has passed since last alert of same type for entity. */
async function isCooldownActive(ruleId: string, entityType: string, entityId: string, cooldownMinutes: number): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  const existing = await db.alert.findFirst({
    where: {
      rule: ruleId,
      entityType,
      entityId,
      createdAt: { gte: since },
    },
  });
  return !!existing;
}

/** Create a new alert. */
async function createAlert(rule: AlertRule, entityType: string, entityId: string, message: string): Promise<void> {
  await db.alert.create({
    data: {
      organizationId: "unassigned",
      rule: rule.id,
      severity: rule.severity,
      entityType,
      entityId,
      message,
    },
  });
}

/** Check AP down alerts. */
async function checkApDown(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "ap_down");
  if (!rule || !rule.enabled) return;

  const durationMs = (rule.threshold.durationMinutes ?? 5) * 60 * 1000;
  const cutoff = new Date(Date.now() - durationMs);

  // Find APs that were online but haven't been seen recently
  const aps = await db.networkDevice.findMany({
    where: {
      accessPoint: { not: null, not: "" },
      status: "online",
      lastSeen: { lt: cutoff },
    },
    select: { accessPoint: true, routerId: true, organizationId: true, lastSeen: true },
  });

  for (const ap of aps) {
    const entityId = `${ap.routerId}:${ap.accessPoint}`;
    if (await isCooldownActive(rule.id, "ap", entityId, rule.cooldownMinutes)) continue;

    const minutes = Math.round((Date.now() - ap.lastSeen!.getTime()) / 60000);
    await createAlert(rule, "ap", entityId, `Access Point "${ap.accessPoint}" has been offline for ${minutes} minutes`);
    result.alertsCreated++;
  }
}

/** Check router down alerts. */
async function checkRouterDown(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "router_down");
  if (!rule || !rule.enabled) return;

  const durationMs = (rule.threshold.durationMinutes ?? 2) * 60 * 1000;
  const cutoff = new Date(Date.now() - durationMs);

  const routers = await db.router.findMany({
    where: {
      status: { not: "offline" },
      lastSyncAt: { lt: cutoff },
      isDemo: false,
    },
    select: { id: true, name: true, lastSyncAt: true },
  });

  for (const router of routers) {
    if (await isCooldownActive(rule.id, "router", router.id, rule.cooldownMinutes)) continue;

    const minutes = Math.round((Date.now() - router.lastSyncAt!.getTime()) / 60000);
    await createAlert(rule, "router", router.id, `Router "${router.name}" has been unreachable for ${minutes} minutes`);
    result.alertsCreated++;
  }
}

/** Check traffic spike alerts using statistical analysis. */
async function checkTrafficSpike(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "traffic_spike");
  if (!rule || !rule.enabled) return;

  const stdDevThreshold = rule.threshold.standardDeviations ?? 3;
  const minDurationMs = (rule.threshold.minDurationMinutes ?? 10) * 60 * 1000;
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h window for baseline

  // Get daily traffic aggregates for the last 24h
  const aggregates = await db.trafficAggregate.findMany({
    where: {
      entityType: { in: ["ap", "area"] },
      day: { gte: windowStart.toISOString().slice(0, 10) },
    },
    select: { entityType: true, entityId: true, day: true, downMb: true, upMb: true },
  });

  // Group by entity and calculate mean/stddev
  const byEntity = new Map<string, { totals: number[] }>();
  for (const a of aggregates) {
    const total = a.downMb + a.upMb;
    if (total === 0) continue;
    const key = `${a.entityType}:${a.entityId}`;
    if (!byEntity.has(key)) byEntity.set(key, { totals: [] });
    byEntity.get(key)!.totals.push(total);
  }

  for (const [entityKey, data] of byEntity) {
    if (data.totals.length < 3) continue; // Need at least 3 data points

    const mean = data.totals.reduce((s, v) => s + v, 0) / data.totals.length;
    const variance = data.totals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / data.totals.length;
    const stdDev = Math.sqrt(variance);
    const threshold = mean + stdDevThreshold * stdDev;

    // Check recent samples (last hour) for spike
    const recentStart = new Date(Date.now() - minDurationMs);
    const recentAgg = await db.trafficAggregate.findMany({
      where: {
        entityType: entityKey.split(":")[0] as "ap" | "area",
        entityId: entityKey.split(":")[1],
        day: new Date().toISOString().slice(0, 10),
        // Note: This is a simplified check - in production you'd check hourly/minutely samples
      },
    });

    // For now, just check if today's total exceeds threshold
    const todayAgg = recentAgg.find((a) => a.day === new Date().toISOString().slice(0, 10));
    if (!todayAgg) continue;
    const todayTotal = todayAgg.downMb + todayAgg.upMb;

    if (todayTotal > threshold) {
      if (await isCooldownActive(rule.id, entityKey.split(":")[0], entityKey, rule.cooldownMinutes)) continue;

      await createAlert(rule, entityKey.split(":")[0], entityKey.split(":")[1],
        `Traffic spike detected on ${entityKey}: ${(todayTotal / 1024).toFixed(2)} GB today (threshold: ${(threshold / 1024).toFixed(2)} GB)`);
      result.alertsCreated++;
    }
  }
}

/** Check packet loss alerts from firewall connections. */
async function checkPacketLoss(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "packet_loss");
  if (!rule || !rule.enabled) return;

  const maxLoss = rule.threshold.maxLossPercent ?? 5;

  // Get recent firewall connection stats
  const resources = await db.networkResource.findMany({
    where: { source: "firewall_connections", seenAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
    select: { routerId: true, data: true },
  });

  for (const res of resources) {
    try {
      const data = JSON.parse(res.data);
      // RouterOS firewall connections output varies; simplified check
      // In production, you'd parse established/related/invalid counts
    } catch {}
  }
}

/** Check high latency alerts from router test results. */
async function checkHighLatency(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "high_latency");
  if (!rule || !rule.enabled) return;

  const maxLatency = rule.threshold.maxLatencyMs ?? 200;

  // Check recent router test results
  // This would require storing test results; simplified for now
}

/** Check device missing alerts. */
async function checkDeviceMissing(rules: AlertRule[], result: AlertCheckResult): Promise<void> {
  const rule = rules.find((r) => r.id === "device_missing");
  if (!rule || !rule.enabled) return;

  const missingMs = (rule.threshold.missingMinutes ?? 30) * 60 * 1000;
  const cutoff = new Date(Date.now() - missingMs);

  // Find devices that were online/idle but haven't been seen recently
  const devices = await db.networkDevice.findMany({
    where: {
      status: { in: ["online", "idle"] },
      lastSeen: { lt: cutoff },
    },
    select: { id: true, macAddress: true, hostname: true, routerId: true, organizationId: true, lastSeen: true },
  });

  for (const dev of devices) {
    if (await isCooldownActive(rule.id, "device", dev.id, rule.cooldownMinutes)) continue;

    const minutes = Math.round((Date.now() - dev.lastSeen!.getTime()) / 60000);
    await createAlert(rule, "device", dev.id, `Device "${dev.customName || dev.hostname || dev.macAddress}" has not been seen for ${minutes} minutes`);
    result.alertsCreated++;
  }
}

/** Run all alert checks. */
export async function runAlertChecks(): Promise<AlertCheckResult> {
  const rules = await getRules();
  const result: AlertCheckResult = { alertsCreated: 0, errors: [] };

  try {
    await checkApDown(rules, result);
    await checkRouterDown(rules, result);
    await checkTrafficSpike(rules, result);
    await checkPacketLoss(rules, result);
    await checkHighLatency(rules, result);
    await checkDeviceMissing(rules, result);
  } catch (e) {
    result.errors.push((e as Error).message);
  }

  return result;
}

/** Get alerts for display. */
export async function getAlerts(organizationId: string, options: {
  severity?: string;
  entityType?: string;
  acknowledged?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<{ alerts: any[]; total: number }> {
  const where: any = { organizationId };
  if (options.severity) where.severity = options.severity;
  if (options.entityType) where.entityType = options.entityType;
  if (options.acknowledged !== undefined) where.acknowledgedAt = options.acknowledged ? { not: null } : null;

  const [alerts, total] = await Promise.all([
    db.alert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: options.limit ?? 50,
      skip: options.offset ?? 0,
    }),
    db.alert.count({ where }),
  ]);

  return { alerts, total };
}

/** Acknowledge an alert. */
export async function acknowledgeAlert(alertId: string): Promise<void> {
  await db.alert.update({
    where: { id: alertId },
    data: { acknowledgedAt: new Date() },
  });
}