/**
 * Background Discovery Synchronization Engine.
 *
 * - Runs inside the Next.js server process (started from src/instrumentation.ts)
 * - One connection per router per cycle; every collector runs real RouterOS commands
 * - Adaptive polling: on failure the next run backs off exponentially (min interval → 15 min)
 * - Persists raw source rows, correlates devices, derives presence, stores history,
 *   writes traffic samples + daily aggregates, KPI snapshots and new-device notifications
 * - Retention: samples 48h, observations 30d, snapshots 30d, stale source rows 7d
 *
 * The scheduler NEVER marks a router online without an authenticated API response.
 */

import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { connectRouterOS, withRouter, runCommand, type RosConnection, type TunnelTransport } from "@/lib/routeros";
import { resolveAgentTunnel, openAgentTunnel } from "@/lib/agent-tunnel";
import { runWithTenant } from "@/lib/tenant-context";
import {
  collectAllSources, collectInterfaceTraffic,
  normalizeLease, normalizeArp, normalizeBridgeHost, normalizeWireless,
  normalizeHotspotActive, normalizePppActive,
  normalizeTraffic,
} from "./collectors";
import { correlateDevices, detectWanInterfaces, isLocallyAdministeredMac, type CorrelatedDevice, type NeighborInfo } from "./correlate";
import { derivePresence } from "./presence";
import { lookupManufacturer } from "./oui";

interface SyncPolicy {
  graceMs: number;
  l2l3FreshMs: number;
  notifyNewDevices: boolean;
  notifyOfflineDevices: boolean;
  collectInterfaceTraffic: boolean;
}

const DEFAULTS: SyncPolicy = {
  graceMs: 5 * 60_000,
  l2l3FreshMs: 120_000,
  notifyNewDevices: true,
  notifyOfflineDevices: false,
  collectInterfaceTraffic: true,
};

async function getPolicy(): Promise<SyncPolicy> {
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["discovery_grace_min", "discovery_notify_new", "discovery_notify_offline", "discovery_interface_traffic"] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    return {
      graceMs: Math.max(1, parseInt(get("discovery_grace_min") ?? "", 10) || 5) * 60_000,
      l2l3FreshMs: DEFAULTS.l2l3FreshMs,
      notifyNewDevices: (get("discovery_notify_new") ?? "true") !== "false",
      notifyOfflineDevices: (get("discovery_notify_offline") ?? "false") === "true",
      collectInterfaceTraffic: (get("discovery_interface_traffic") ?? "true") !== "false",
    };
  } catch {
    return DEFAULTS;
  }
}

// --------------- hotspot byte-delta tracker (in-memory, per process) ---------------
interface ByteTrack { in: number; out: number; ts: number; }
const g = globalThis as unknown as {
  __mcm_hotspot_bytes?: Map<string, ByteTrack>;
  __mcm_last_traffic?: Map<string, { rx: number; tx: number }>;
  __mcm_scheduler?: NodeJS.Timeout;
  __mcm_syncing?: Set<string>;
  __mcm_last_retention?: number;
};
if (!g.__mcm_hotspot_bytes) g.__mcm_hotspot_bytes = new Map();
if (!g.__mcm_last_traffic) g.__mcm_last_traffic = new Map();
if (!g.__mcm_syncing) g.__mcm_syncing = new Set();

// --------------- main per-router sync ---------------
export interface SyncResult {
  ok: boolean;
  jobId?: string;
  error?: string;
  stats?: Record<string, unknown>;
}

export async function syncRouter(routerId: string, trigger: "scheduler" | "user" = "scheduler"): Promise<SyncResult> {
  if (g.__mcm_syncing!.has(routerId)) return { ok: false, error: "sync already running for this router" };
  g.__mcm_syncing!.add(routerId);
  const started = Date.now();

  const router = await db.router.findUnique({ where: { id: routerId } });
  if (!router) return { ok: false, error: "router not found" };

  // Run the sync with the router's organization context
  return runWithTenant({ organizationId: router.organizationId, isPlatform: false }, async () => {
    const job = await db.discoveryJob.create({
      data: { routerId, type: trigger === "user" ? "manual" : "scheduled", status: "running", trigger },
    });
    const log = (level: string, source: string | null, message: string) =>
      db.discoveryJobLog.create({ data: { jobId: job.id, level, source, message } }).catch(() => {});

    try {
      await log("info", null, `بدء مزامنة الاكتشاف (${trigger}) — ${router.host}:${router.useTls ? router.apiSslPort : router.apiPort}`);
      let password = "";
      try { password = decryptSecret(router.apiPasswordEnc); } catch {
        throw new Error("تعذر فك تشفير بيانات الدخول (APP_SECRET mismatch)");
      }
      const connPort = router.useTls ? router.apiSslPort : router.apiPort;
      let connTransport: TunnelTransport | undefined;
      try {
        const tunnelInfo = await resolveAgentTunnel(router);
        if (tunnelInfo) {
          connTransport = {
            describe: () => `agent tunnel (${tunnelInfo.agentName} → ${router.host}:${connPort})`,
            open: () => openAgentTunnel({ ...tunnelInfo, port: connPort, useTls: router.useTls }),
          };
        }
      } catch (e) {
        await db.router.update({
          where: { id: router.id },
          data: { lastSyncAt: new Date(), lastSyncOk: false, lastSyncError: (e as Error).message },
        }).catch(() => {});
        throw e;
      }
      const connRes = await connectRouterOS({
        host: router.host,
        port: connPort,
        useTls: router.useTls,
        username: router.apiUsername,
        password,
        connectTimeoutMs: 6000,
        commandTimeoutMs: 12000,
        transport: connTransport,
      });
      if (!connRes.ok || !connRes.conn) {
        throw new Error(connRes.error ?? "connection failed");
    }
    const conn = connRes.conn;

    const policy = await getPolicy();
    const sourcesOut = await collectAllSources(conn);
    const now = new Date();

    // -------- raw router info (reuse existing Router fields — keeps old views working) --------
    try {
      const [resource, identity] = await Promise.all([
        runCommand(conn, ["/system/resource/print"]),
        runCommand(conn, ["/system/identity/print"]),
      ]);
      const res = resource.data[0] ?? {};
      const idn = identity.data[0] ?? {};
      const totalMem = parseInt(res["total-memory"] ?? "0", 10) / 1048576 || 0;
      const freeMem = parseInt(res["free-memory"] ?? "0", 10) / 1048576 || 0;
      await db.router.update({
        where: { id: routerId },
        data: {
          identity: idn.name ?? router.identity,
          version: res.version ?? router.version,
          boardName: res["board-name"] ?? router.boardName,
          uptime: res.uptime ?? router.uptime,
          cpuLoad: parseInt(res["cpu-load"] ?? "0", 10),
          freeMemoryMb: Math.round(freeMem),
          totalMemoryMb: Math.round(totalMem),
          status: "online",
          statusMessage: null,
          lastCheckedAt: now,
          lastOnlineAt: now,
        },
      });
    } catch (e) {
      await log("warn", "system", `تعذر قراءة معلومات السيرفر: ${(e as Error).message}`);
    }

    // -------- persist per-source raw rows --------
    const stats: Record<string, number | string> = {};
    const leaseRows = (sourcesOut.sources.dhcp_leases ?? []).map(normalizeLease).filter((x): x is NonNullable<typeof x> => !!x);
    const arpRows = (sourcesOut.sources.arp ?? []).map(normalizeArp).filter((x): x is NonNullable<typeof x> => !!x);
    const bridgeRows = (sourcesOut.sources.bridge_hosts ?? []).map(normalizeBridgeHost).filter((x): x is NonNullable<typeof x> => !!x);
    const wirelessRows: NonNullable<ReturnType<typeof normalizeWireless>>[] = [];
    for (const p of ["wireless", "wifi", "capsman"] as const) {
      for (const r of sourcesOut.sources[p] ?? []) {
        const n = normalizeWireless(r, p);
        if (n) wirelessRows.push(n);
      }
    }
    const hotspotRows = (sourcesOut.sources.hotspot_active ?? []).map(normalizeHotspotActive).filter((x): x is NonNullable<typeof x> => !!x);
    const hotspotHostRows = (sourcesOut.sources.hotspot_host ?? []).map((r) => ({ mac: r["mac-address"], ip: r.address, interface: r.interface }));
    const pppRows = (sourcesOut.sources.ppp_active ?? []).map(normalizePppActive).filter((x): x is NonNullable<typeof x> => !!x);

    stats.dhcp_leases = leaseRows.length;
    stats.arp = arpRows.length;
    stats.bridge_hosts = bridgeRows.length;
    stats.wireless = wirelessRows.length;
    stats.hotspot_active = hotspotRows.length;
    stats.ppp_active = pppRows.length;
    stats.unsupported = sourcesOut.unsupported.join(",") || "-";
    stats.failed = Object.keys(sourcesOut.failed).join(",") || "-";

    // DHCP leases
    for (const l of leaseRows) {
      await db.dhcpLease.upsert({
        where: { routerId_address_macAddress: { routerId, address: l.address, macAddress: l.mac } },
        create: { routerId, address: l.address, macAddress: l.mac, hostname: l.hostname, serverName: l.serverName, status: l.status, dynamic: l.dynamic, blocked: l.blocked, disabled: l.disabled, expiresAt: l.expiresAt, lastSeen: now, addressPool: l.addressPool, clientId: l.clientId, comment: l.comment, rosId: l.rosId, seenAt: now },
        update: { hostname: l.hostname, serverName: l.serverName, status: l.status, dynamic: l.dynamic, blocked: l.blocked, disabled: l.disabled, expiresAt: l.expiresAt, lastSeen: now, addressPool: l.addressPool, clientId: l.clientId, comment: l.comment, rosId: l.rosId, seenAt: now },
      }).catch((e) => log("warn", "dhcp", `lease upsert ${l.address}: ${e.message}`));
    }
    // ARP
    for (const a of arpRows) {
      await db.arpEntry.upsert({
        where: { routerId_address: { routerId, address: a.address } },
        create: { routerId, address: a.address, macAddress: a.mac, interface: a.interface, dynamic: a.dynamic, complete: a.complete, invalid: a.invalid, published: a.published, comment: a.comment, rosId: a.rosId, seenAt: now },
        update: { macAddress: a.mac, interface: a.interface, dynamic: a.dynamic, complete: a.complete, invalid: a.invalid, published: a.published, comment: a.comment, rosId: a.rosId, seenAt: now },
      }).catch(() => {});
    }
    // Bridge hosts
    for (const b of bridgeRows) {
      await db.bridgeHost.upsert({
        where: { routerId_macAddress_bridge_interface: { routerId, macAddress: b.mac, bridge: b.bridge ?? "", interface: b.interface ?? "" } },
        create: { routerId, macAddress: b.mac, bridge: b.bridge, interface: b.interface, vlanId: b.vlanId, isLocal: b.isLocal, dynamic: b.dynamic, externalFdb: b.externalFdb, rosId: b.rosId, seenAt: now },
        update: { vlanId: b.vlanId, isLocal: b.isLocal, dynamic: b.dynamic, externalFdb: b.externalFdb, rosId: b.rosId, seenAt: now },
      }).catch(() => {});
    }
    // Wireless
    for (const w of wirelessRows) {
      await db.wirelessClient.upsert({
        where: { routerId_macAddress_apiPath: { routerId, macAddress: w.mac, apiPath: w.apiPath } },
        create: { routerId, macAddress: w.mac, apiPath: w.apiPath, interface: w.interface, radioName: w.radioName, ssid: w.ssid, signal: w.signal, txRate: w.txRate, rxRate: w.rxRate, uptime: w.uptime, band: w.band, rxSignalCh: w.rxSignalCh, registeredAt: w.registeredAt, rosId: w.rosId, seenAt: now },
        update: { interface: w.interface, radioName: w.radioName, ssid: w.ssid, signal: w.signal, txRate: w.txRate, rxRate: w.rxRate, uptime: w.uptime, band: w.band, rxSignalCh: w.rxSignalCh, registeredAt: w.registeredAt, rosId: w.rosId, seenAt: now },
      }).catch(() => {});
    }
    // PPP sessions
    for (const p of pppRows) {
      await db.pppSession.upsert({
        where: { routerId_username_service: { routerId, username: p.username, service: p.service ?? "" } },
        create: { routerId, username: p.username, service: p.service, callerId: p.callerId, address: p.address, profile: p.profile, uptime: p.uptime, encoding: p.encoding, rosId: p.rosId, seenAt: now },
        update: { callerId: p.callerId, address: p.address, profile: p.profile, uptime: p.uptime, encoding: p.encoding, rosId: p.rosId, seenAt: now },
      }).catch(() => {});
    }
    // Generic resources (interfaces / addresses / dhcp servers & networks / neighbors / routes / connections / address-lists)
    const resourcePlan: { source: string; keyFn: (r: Record<string, string>) => string | null }[] = [
      { source: "interfaces", keyFn: (r) => r.name ?? null },
      { source: "addresses", keyFn: (r) => (r.address ? `${r.address}|${r.interface ?? ""}` : null) },
      { source: "dhcp_servers", keyFn: (r) => r.name ?? null },
      { source: "dhcp_networks", keyFn: (r) => r.address ?? null },
      { source: "neighbors", keyFn: (r) => (r["mac-address"] ? `${r["mac-address"]}|${r.interface ?? ""}` : r.identity ?? null) },
      { source: "routes", keyFn: (r) => (r["dst-address"] ? `${r["dst-address"]}|${r["gateway"] ?? ""}` : null) },
      { source: "firewall_connections", keyFn: (r) => r[".id"] ?? null },
      { source: "address_lists", keyFn: (r) => (r.list && r.address ? `${r.list}|${r.address}` : null) },
    ];
    for (const plan of resourcePlan) {
      const rows = sourcesOut.sources[plan.source as keyof typeof sourcesOut.sources] ?? [];
      for (const r of rows) {
        const key = plan.keyFn(r);
        if (!key) continue;
        await db.networkResource.upsert({
          where: { routerId_source_key: { routerId, source: plan.source, key } },
          create: { routerId, source: plan.source, key, data: JSON.stringify(r), seenAt: now },
          update: { data: JSON.stringify(r), seenAt: now },
        }).catch(() => {});
      }
      await db.networkResource.deleteMany({
        where: { routerId, source: plan.source, seenAt: { lt: new Date(now.getTime() - 7 * 86400_000) } },
      }).catch(() => {});
    }

    // -------- interface traffic (one 1-second sample) --------
    let ifaceTraffic: { interface: string; rxMbps: number; txMbps: number }[] = [];
    if (policy.collectInterfaceTraffic) {
      const t = await collectInterfaceTraffic(conn, true);
      if (t.ok) {
        ifaceTraffic = t.rows.map(normalizeTraffic).filter(Boolean) as { interface: string; rxMbps: number; txMbps: number }[];
        // persist per-interface samples — topology link bandwidth + live traffic views
        for (const s of ifaceTraffic) {
          await db.networkResource.upsert({
            where: { routerId_source_key: { routerId, source: "interface_traffic", key: s.interface } },
            create: { routerId, source: "interface_traffic", key: s.interface, data: JSON.stringify({ rxMbps: s.rxMbps, txMbps: s.txMbps, ts: now.getTime() }), seenAt: now },
            update: { data: JSON.stringify({ rxMbps: s.rxMbps, txMbps: s.txMbps, ts: now.getTime() }), seenAt: now },
          }).catch(() => {});
        }
        // router-level metric — feeds the EXISTING monitoring view
        const rxSum = ifaceTraffic.reduce((s, i) => s + i.rxMbps, 0);
        const txSum = ifaceTraffic.reduce((s, i) => s + i.txMbps, 0);
        const activeUsers = hotspotRows.length + pppRows.length + wirelessRows.length;
        await db.routerMetric.create({
          data: { routerId, ts: now, downloadMbps: Number(rxSum.toFixed(2)), uploadMbps: Number(txSum.toFixed(2)), cpuLoad: 0, activeUsers },
        }).catch(() => {});
        stats.traffic_interfaces = ifaceTraffic.length;
      } else {
        await log("warn", "interface_traffic", `تعذر أخذ عينة الحركة: ${t.error ?? ""}`);
      }
    }

    await conn.close();

    // -------- correlation + presence + device persistence --------
    const neighbors: NeighborInfo[] = (sourcesOut.sources.neighbors ?? [])
      .filter((r) => r["mac-address"])
      .map((r) => ({ mac: r["mac-address"], identity: r.identity, interface: r.interface, platform: r.platform, version: r.version, board: r["board-name"], discoveredBy: r.discovered_by ?? r["discovered-by"] }));

    // WAN interface(s) from the real 0.0.0.0/0 default route. ARP/bridge hosts
    // seen only there are upstream infrastructure, not managed-LAN clients.
    const wanInterfaces = detectWanInterfaces(
      (sourcesOut.sources.routes ?? []).map((r) => ({ data: JSON.stringify(r) })),
    );
    stats.wan_interfaces = wanInterfaces.join(",") || "-";

    const correlated = correlateDevices({
      dhcpLeases: leaseRows,
      arpEntries: arpRows,
      bridgeHosts: bridgeRows,
      wireless: wirelessRows,
      hotspotActive: hotspotRows,
      hotspotHosts: hotspotHostRows,
      pppActive: pppRows,
      neighbors,
      wanInterfaces,
    });

    let newDevices = 0;
    const kpi = { total: 0, online: 0, offline: 0, idle: 0, unknown: 0, wireless: 0, wired: 0, hotspot: 0, pppoe: 0, blocked: 0 };
    const keptMacs = new Set<string>();

    for (const c of correlated.filter((x) => !x.isLocalDevice)) {
      keptMacs.add(c.mac);
      kpi.total++;
      const existing = await db.networkDevice.findUnique({
        where: { routerId_macAddress: { routerId, macAddress: c.mac } },
      });
      const oui = lookupManufacturer(c.mac);
      const prev = existing
        ? { status: existing.status, lastActive: existing.lastActive?.getTime() ?? null, blocked: existing.trustStatus === "blocked" || existing.status === "blocked" }
        : null;
      const presence = derivePresence(c, prev, {
        now: now.getTime(),
        activeFreshMs: 2.5 * 60_000,
        l2l3FreshMs: policy.l2l3FreshMs,
        graceMs: policy.graceMs,
      });
      if (presence.status === "online") kpi.online++;
      else if (presence.status === "offline") kpi.offline++;
      else if (presence.status === "idle") kpi.idle++;
      else if (presence.status === "blocked") kpi.blocked++;
      else kpi.unknown++;
      if (c.wirelessActiveNow) kpi.wireless++;
      else if (c.connectionType === "wired") kpi.wired++;
      if (c.hotspotActiveNow) kpi.hotspot++;
      if (c.pppActiveNow) kpi.pppoe++;

      const isNewDevice = !existing;
      if (isNewDevice) newDevices++;

      // events
      const events: { type: string; oldValue?: string; newValue?: string; source?: string; details?: string }[] = [];
      if (isNewDevice) {
        events.push({ type: "first_seen", source: c.sources[0], details: `discovered via: ${c.sources.join(", ")}` });
      }
      if (existing && existing.status !== presence.status) {
        events.push({ type: presence.status === "online" ? "online" : presence.status === "offline" ? "offline" : "status_change", oldValue: existing.status, newValue: presence.status, details: presence.evidence.join("; ") });
      }
      if (existing && existing.ipAddress && c.ipAddress && existing.ipAddress !== c.ipAddress) {
        events.push({ type: "ip_change", oldValue: existing.ipAddress, newValue: c.ipAddress });
      }
      if (existing && existing.interfaceName && c.interfaceName && existing.interfaceName !== c.interfaceName) {
        events.push({ type: "interface_change", oldValue: existing.interfaceName, newValue: c.interfaceName });
      }
      if (existing && existing.accessPoint && c.accessPoint && existing.accessPoint !== c.accessPoint) {
        events.push({ type: "ap_change", oldValue: existing.accessPoint, newValue: c.accessPoint });
      }

      const data = {
        ipAddress: c.ipAddress,
        hostname: c.hostname,
        manufacturer: oui.manufacturer,
        connectionType: c.connectionType,
        interfaceName: c.interfaceName,
        vlanId: c.vlanId,
        accessPoint: c.accessPoint,
        status: presence.status,
        sources: JSON.stringify(c.sources),
        sourceDetails: JSON.stringify(c.sourceDetails),
        operatingSystem: c.selfReportedOs,
        lastSeen: now,
        lastActive: (c.hotspotActiveNow || c.pppActiveNow || c.wirelessActiveNow) ? now : existing?.lastActive ?? null,
        updatedAt: now,
      };

      const device = await db.networkDevice.upsert({
        where: { routerId_macAddress: { routerId, macAddress: c.mac } },
        create: { ...data, routerId, macAddress: c.mac, deviceCategory: "unknown", firstSeen: now, isNew: true, organizationId: router.organizationId },
        update: { ...data, organizationId: router.organizationId },
      }).catch(async () => db.networkDevice.findUnique({ where: { routerId_macAddress: { routerId, macAddress: c.mac } } }));

      if (!device) continue;

      for (const ev of events) {
        await db.deviceEvent.create({ data: { deviceId: device.id, type: ev.type, oldValue: ev.oldValue, newValue: ev.newValue, source: ev.source, details: ev.details } }).catch(() => {});
      }
      // observation row on first discovery only (bounded growth)
      if (isNewDevice) {
        await db.deviceObservation.create({ data: { deviceId: device.id, routerId, source: c.sources[0] ?? "unknown", mac: c.mac, ip: c.ipAddress, state: presence.status, raw: JSON.stringify(c.sourceDetails) } }).catch(() => {});
      }
      // IP history
      if (c.ipAddress) {
        await db.deviceIpHistory.upsert({
          where: { deviceId_ipAddress: { deviceId: device.id, ipAddress: c.ipAddress } },
          create: { deviceId: device.id, ipAddress: c.ipAddress, interface: c.interfaceName, source: c.sources[0] ?? null, firstSeen: now, lastSeen: now },
          update: { lastSeen: now, interface: c.interfaceName, source: c.sources[0] ?? null },
        }).catch(() => {});
      }

      // new-device notification (policy-controlled)
      if (isNewDevice && policy.notifyNewDevices) {
        await db.notification.create({
          data: {
            title: "جهاز جديد مكتشف / New device discovered",
            body: `${c.hostname ?? c.mac} — ${c.ipAddress ?? "?"} (${oui.manufacturer ?? "مصنّع غير معروف"}) على ${router.name}`,
            type: "router", severity: "info",
          },
        }).catch(() => {});
      }
      // offline notification (policy-controlled, default off)
      if (policy.notifyOfflineDevices && existing && existing.status === "online" && presence.status === "offline") {
        await db.notification.create({
          data: {
            title: "جهاز غير متصل / Device offline",
            body: `${c.hostname ?? c.mac} (${c.ipAddress ?? "?"}) لم يعد متصلاً على ${router.name}`,
            type: "router", severity: "warning",
          },
        }).catch(() => {});
      }

      // traffic attribution (see attachTraffic)
      await attachTraffic(device.id, c, ifaceTraffic, now, wirelessRows, bridgeRows);
    }

    // hotspot/PPPoE devices that lack MAC correlation still update session-based KPIs via ppp/hotspot rows above

    // Reconcile device records that are no longer returned by correlation.
    // (A device whose hotspot/PPP/wireless session ended — and has no fresh
    //  ARP/DHCP/bridge evidence — is absent from `correlated`, so the loop above
    //  never re-evaluates it and it would otherwise stay stuck as "online".)
    {
      const existingDevices = await db.networkDevice.findMany({
        where: { routerId },
        select: { id: true, macAddress: true, ipAddress: true, interfaceName: true, sources: true, status: true, lastActive: true, trustStatus: true },
      });
      for (const d of existingDevices) {
        if (keptMacs.has(d.macAddress)) continue;
        const onWanIface = d.interfaceName && wanInterfaces.some((w) => w.toLowerCase() === String(d.interfaceName).toLowerCase());
        const arpOnWan = arpRows.some((a) => a.mac === d.macAddress && wanInterfaces.some((w) => w.toLowerCase() === String(a.interface).toLowerCase()));
        const srcs: string[] = Array.isArray(d.sources) ? d.sources : (() => { try { return JSON.parse(d.sources || "[]"); } catch { return []; } })();
        const staleRandomBridge = srcs.length === 1 && srcs[0] === "bridge" && isLocallyAdministeredMac(d.macAddress);
        // Upstream/WAN-only and random bridge-only records are bogus → remove.
        if (onWanIface || arpOnWan || staleRandomBridge) {
          await db.networkDevice.delete({ where: { id: d.id } }).catch(() => {});
          continue;
        }
        // Genuine client with no current evidence → it is no longer online.
        // Respect the grace window: recent session loss = recently_disconnected.
        if (d.status !== "offline" && d.trustStatus !== "blocked") {
          const lastActiveMs = d.lastActive?.getTime() ?? null;
          const withinGrace = lastActiveMs != null && (now.getTime() - lastActiveMs) < policy.graceMs;
          await db.networkDevice.update({
            where: { id: d.id },
            data: {
              status: withinGrace ? "recently_disconnected" : "offline",
              ipAddress: null,
              lastSeen: now,
              updatedAt: now,
            },
          }).catch(() => {});
        }
      }
    }

    await db.deviceStatsSnapshot.create({
      data: { routerId, ...kpi, newDevices },
    }).catch(() => {});

    // mark router sync health
    const partial = Object.keys(sourcesOut.failed).length > 0;
    await db.router.update({
      where: { id: routerId },
      data: {
        lastSyncAt: now, lastSyncOk: true, lastSyncError: null,
        syncFailCount: 0,
        nextSyncAt: new Date(now.getTime() + Math.max(15, router.syncIntervalSec) * 1000),
      },
    });
    await db.discoveryJob.update({
      where: { id: job.id },
      data: {
        status: partial ? "partial" : "success",
        sourcesDone: JSON.stringify(sourcesOut.supported),
        sourcesFailed: JSON.stringify(Object.keys(sourcesOut.failed)),
        stats: JSON.stringify({ ...stats, devices: correlated.length, newDevices, kpi }),
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });
    await log("info", null, `اكتملت المزامنة: ${correlated.length} جهاز (${newDevices} جديد) في ${Date.now() - started}ms`);

    return { ok: true, jobId: job.id, stats: { ...stats, devices: correlated.length, newDevices } };
  } catch (e) {
    const err = (e as Error).message;
    const now = new Date();
    const backoffSec = Math.min(Math.max(15, (router.syncIntervalSec || 60) * Math.pow(2, router.syncFailCount + 1)), 900);
    await db.router.update({
      where: { id: routerId },
      data: {
        status: "offline",
        statusMessage: err,
        lastCheckedAt: now,
        lastSyncAt: now,
        lastSyncOk: false,
        lastSyncError: err,
        syncFailCount: { increment: 1 },
        nextSyncAt: new Date(now.getTime() + backoffSec * 1000),
      },
    }).catch(() => {});
    await db.discoveryJob.update({
      where: { id: job.id },
      data: { status: "failed", error: err, durationMs: Date.now() - started, finishedAt: now },
    }).catch(() => {});
    await log("error", null, `فشلت المزامنة: ${err}`);
    return { ok: false, jobId: job.id, error: err };
  } finally {
    g.__mcm_syncing!.delete(routerId);
  }
});
}

/**
 * Honest per-device traffic attribution:
 *  - hotspot: real session byte deltas (source=session)
 *  - pppoe: real per-user interface rate via dynamic <pppoe-…> interfaces (source=interface)
 *  - single-device interface: real interface rate attributed 1:1 (source=interface)
 *  - multi-device interface: NO per-device attribution is invented (interface aggregate
 *    stays at router level; topology shows it as link bandwidth)
 */
async function attachTraffic(
  deviceId: string,
  c: CorrelatedDevice,
  ifaceTraffic: { interface: string; rxMbps: number; txMbps: number }[],
  now: Date,
  wirelessRows: NonNullable<ReturnType<typeof normalizeWireless>>[],
  bridgeRows: NonNullable<ReturnType<typeof normalizeBridgeHost>>[],
): Promise<void> {
  // 1. hotspot real byte deltas
  if (c.hotspotActiveNow && (c.hotspotBytesIn != null || c.hotspotBytesOut != null)) {
    const key = deviceId;
    const track = g.__mcm_hotspot_bytes!.get(key);
    if (track) {
      const dt = Math.max(1, (now.getTime() - track.ts) / 1000);
      const dIn = Math.max(0, (c.hotspotBytesIn ?? track.in) - track.in);
      const dOut = Math.max(0, (c.hotspotBytesOut ?? track.out) - track.out);
      const rxMbps = (dIn * 8) / dt / 1e6;
      const txMbps = (dOut * 8) / dt / 1e6;
      await db.deviceTrafficSample.create({ data: { deviceId, rxMbps, txMbps, source: "session", ts: now } }).catch(() => {});
      await upsertDaily(deviceId, now, dIn / 1e6, dOut / 1e6); // real bytes → MB
    } else {
      await db.deviceTrafficSample.create({ data: { deviceId, rxMbps: 0, txMbps: 0, source: "session", ts: now } }).catch(() => {});
    }
    g.__mcm_hotspot_bytes!.set(key, { in: c.hotspotBytesIn ?? 0, out: c.hotspotBytesOut ?? 0, ts: now.getTime() });
    return;
  }

  // 2. pppoe real per-user interface rate (dynamic interface named <pppoe-user>)
  if (c.pppActiveNow) {
    const dyn = ifaceTraffic.find((t) => t.interface.includes("<") && t.interface.includes(">"));
    if (dyn) {
      await db.deviceTrafficSample.create({ data: { deviceId, rxMbps: dyn.rxMbps, txMbps: dyn.txMbps, source: "interface", ts: now } }).catch(() => {});
      await upsertDaily(deviceId, now, (dyn.rxMbps / 8) * 60, (dyn.txMbps / 8) * 60);
      return;
    }
  }

  // 3. single-device interface attribution (real rate, 1:1)
  const iface = c.interfaceName;
  if (iface && !iface.startsWith("bridge") && !/<|wlan|wifi|cap/.test(iface)) {
    const t = ifaceTraffic.find((i) => i.interface === iface);
    if (t) {
      const devicesOnIface = bridgeRows.filter((b) => b.interface === iface && !b.isLocal).length
        + wirelessRows.filter((w) => w.interface === iface).length;
      if (devicesOnIface <= 1) {
        await db.deviceTrafficSample.create({ data: { deviceId, rxMbps: t.rxMbps, txMbps: t.txMbps, source: "interface", ts: now } }).catch(() => {});
        await upsertDaily(deviceId, now, (t.rxMbps / 8) * 60, (t.txMbps / 8) * 60);
        return;
      }
    }
  }
  // 4. wireless negotiated rates are NOT throughput — we deliberately do not invent traffic
}

async function upsertDaily(deviceId: string, now: Date, downMb: number, upMb: number): Promise<void> {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await db.deviceTrafficDaily.upsert({
    where: { deviceId_day: { deviceId, day } },
    create: { deviceId, day, downMb, upMb },
    update: { downMb: { increment: downMb }, upMb: { increment: upMb } },
  }).catch(() => {});
}

// --------------- retention ---------------
async function runRetention(): Promise<void> {
  const last = g.__mcm_last_retention ?? 0;
  if (Date.now() - last < 3600_000) return;
  g.__mcm_last_retention = Date.now();
  try {
    const cutoff48h = new Date(Date.now() - 48 * 3600_000);
    const cutoff30d = new Date(Date.now() - 30 * 86400_000);
    const cutoff7d = new Date(Date.now() - 7 * 86400_000);
    await db.deviceTrafficSample.deleteMany({ where: { ts: { lt: cutoff48h } } });
    await db.deviceObservation.deleteMany({ where: { seenAt: { lt: cutoff30d } } });
    await db.deviceStatsSnapshot.deleteMany({ where: { ts: { lt: cutoff30d } } });
    await db.dhcpLease.deleteMany({ where: { seenAt: { lt: cutoff7d } } });
    await db.arpEntry.deleteMany({ where: { seenAt: { lt: cutoff7d } } });
    await db.bridgeHost.deleteMany({ where: { seenAt: { lt: cutoff7d } } });
    await db.wirelessClient.deleteMany({ where: { seenAt: { lt: cutoff7d } } });
    await db.pppSession.deleteMany({ where: { seenAt: { lt: cutoff7d } } });
  } catch { /* retention is best-effort */ }
}

// --------------- scheduler ---------------
let lastAggregationRun = 0;
const AGGREGATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastAlertCheckRun = 0;
const ALERT_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds

export function ensureScheduler(): void {
  if (g.__mcm_scheduler) return;
  console.log("[discovery] scheduler started");
  g.__mcm_scheduler = setInterval(async () => {
    try {
      await runRetention();
      const routers = await db.router.findMany({
        where: { isDemo: false },
        select: { id: true, syncEnabled: true, nextSyncAt: true, syncIntervalSec: true, lastSyncAt: true },
      });
      const now = Date.now();
      for (const r of routers) {
        if (!r.syncEnabled) continue;
        const due = !r.nextSyncAt || r.nextSyncAt.getTime() <= now;
        if (due && !g.__mcm_syncing!.has(r.id)) {
          syncRouter(r.id, "scheduler").catch(() => {});
        }
      }

      // Traffic aggregation (every 5 minutes)
      if (now - lastAggregationRun >= AGGREGATION_INTERVAL_MS) {
        lastAggregationRun = now;
        const { runTrafficAggregation } = await import("@/lib/traffic/aggregation");
        runTrafficAggregation().catch((e) => console.error("[traffic] aggregation error:", (e as Error).message));
      }

      // Alert checks (every 60 seconds)
      if (now - lastAlertCheckRun >= ALERT_CHECK_INTERVAL_MS) {
        lastAlertCheckRun = now;
        const { runAlertChecks } = await import("@/lib/alerts/engine");
        runAlertChecks().catch((e) => console.error("[alerts] check error:", (e as Error).message));
      }
    } catch (e) {
      console.error("[discovery] scheduler tick error:", (e as Error).message);
    }
  }, 10_000);
  // don't keep the process alive just for the scheduler
  g.__mcm_scheduler.unref?.();
}

/** Trigger an immediate manual sync (bypasses schedule). */
export function triggerSyncNow(routerId?: string): Promise<SyncResult[]> {
  return (async () => {
    const ids = routerId
      ? [routerId]
      : (await db.router.findMany({ where: { syncEnabled: true, isDemo: false }, select: { id: true } })).map((r) => r.id);
    const results: SyncResult[] = [];
    for (const id of ids) results.push(await syncRouter(id, "user"));
    return results;
  })();
}

/** Small helper used by API routes to run arbitrary real commands with the stored credentials. */
export async function withRouterCredentials<T>(
  routerId: string,
  fn: (conn: RosConnection) => Promise<T>,
): Promise<{ ok: boolean; error?: string; value?: T }> {
  const router = await db.router.findUnique({ where: { id: routerId } });
  if (!router) return { ok: false, error: "السيرفر غير موجود" };
  let password = "";
  try { password = decryptSecret(router.apiPasswordEnc); } catch {
    return { ok: false, error: "تعذر فك تشفير بيانات الدخول (APP_SECRET mismatch)" };
  }
  const port = router.useTls ? router.apiSslPort : router.apiPort;
  let transport: TunnelTransport | undefined;
  try {
    const tunnelInfo = await resolveAgentTunnel(router);
    if (tunnelInfo) {
      transport = {
        describe: () => `agent tunnel (${tunnelInfo.agentName} → ${router.host}:${port})`,
        open: () => openAgentTunnel({ ...tunnelInfo, port, useTls: router.useTls }),
      };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return withRouter({
    host: router.host,
    port,
    useTls: router.useTls,
    username: router.apiUsername,
    password,
    connectTimeoutMs: 6000,
    commandTimeoutMs: 15000,
    transport,
  }, fn);
}
