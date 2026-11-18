/**
 * Network Topology builder — relationships are drawn ONLY when confirmed by
 * real RouterOS data; anything else is explicitly marked `inferred`.
 *
 * Hierarchy: Internet → MikroTik Router → Bridge / Port / Access Point → Devices
 * Multi-router: Internet → Router A ↔ Router B (LLDP/MNDP) → Bridge / AP / Device
 */

import { db } from "@/lib/db";

export interface TopoNode {
  id: string;
  type: "internet" | "router" | "bridge" | "ap" | "port" | "device";
  label: string;
  ip?: string;
  mac?: string;
  cpu?: number;
  mem?: number;
  memTotal?: number;
  uptime?: string;
  version?: string;
  status?: string;
  online?: boolean;
  counts?: { ok: number; warn: number; err: number };
  vlan?: number | null;
  deviceDbId?: string;
  connectionType?: string;
  manufacturer?: string;
  hostname?: string;
  category?: string;
}

export interface TopoEdge {
  from: string;
  to: string;
  bandwidthMbps?: number;
  inferred: boolean;
  kind: "wan" | "bridge" | "port" | "wireless" | "device" | "router_link";
  label?: string;
}

export interface RouterTopology {
  routerId: string;
  routerName: string;
  networkName: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  unreachable: boolean;
  statusMessage?: string | null;
}

export interface MultiRouterTopology {
  routers: RouterTopology[];
  interRouterLinks: TopoEdge[];
  generatedAt: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Build per-router topology (existing logic, extracted for reuse). */
async function buildSingleRouterTopology(router: any): Promise<RouterTopology> {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const unreachable = router.status !== "online";

  // interface traffic (last 1s samples)
  const trafficRows = await db.networkResource.findMany({
    where: { routerId: router.id, source: "interface_traffic" },
  });
  const traffic = new Map<string, { rxMbps: number; txMbps: number; ts: number }>();
  for (const t of trafficRows) {
    const d = parseJson<{ rxMbps: number; txMbps: number; ts: number }>(t.data, { rxMbps: 0, txMbps: 0, ts: 0 });
    traffic.set(t.key, d);
  }

  // interfaces + routes (for WAN inference)
  const ifaceRows = await db.networkResource.findMany({ where: { routerId: router.id, source: "interfaces" } });
  const ifaces = ifaceRows.map((r) => parseJson<Record<string, string>>(r.data, {}));
  const runningIfaces = new Set(ifaces.filter((i) => i.running === "true" || i.running === "yes").map((i) => i.name));

  // WAN detection: default route (0.0.0.0/0) → interface / gateway (inference, honestly marked)
  const routeRows = await db.networkResource.findMany({ where: { routerId: router.id, source: "routes" } });
  const defaultRoute = routeRows
    .map((r) => parseJson<Record<string, string>>(r.data, {}))
    .find((r) => r["dst-address"] === "0.0.0.0/0" && r["route-targets"] !== undefined || r["dst-address"] === "0.0.0/0");
  const wanIface = defaultRoute?.["immediate-gw"]?.includes("%")
    ? defaultRoute["immediate-gw"].split("%")[1]
    : (defaultRoute?.["gateway-status"]?.match(/via\s+(\S+)/)?.[1] ?? undefined);

  // router node
  const wanT = wanIface ? traffic.get(wanIface) : undefined;
  nodes.push({
    id: `router:${router.id}`,
    type: "router",
    label: router.identity || router.name,
    ip: router.host,
    cpu: router.cpuLoad ?? undefined,
    mem: router.freeMemoryMb != null && router.totalMemoryMb ? Math.round(((router.totalMemoryMb - router.freeMemoryMb) / router.totalMemoryMb) * 100) : undefined,
    memTotal: router.totalMemoryMb ?? undefined,
    uptime: router.uptime ?? undefined,
    version: router.version ?? undefined,
    online: router.status === "online",
  });

  // internet node — only when a default route was actually observed
  let internetId: string | null = null;
  if (defaultRoute) {
    internetId = `internet:${router.id}`;
    nodes.push({ id: internetId, type: "internet", label: "Internet", ip: defaultRoute["gateway"] ?? undefined });
    edges.push({
      from: internetId, to: `router:${router.id}`, kind: "wan",
      bandwidthMbps: wanT ? Number((wanT.rxMbps + wanT.txMbps).toFixed(2)) : undefined,
      inferred: false, label: wanIface,
    });
  } else if (wanIface) {
    internetId = `internet:${router.id}`;
    nodes.push({ id: internetId, type: "internet", label: "Internet (inferred)" });
    edges.push({
      from: internetId, to: `router:${router.id}`, kind: "wan", inferred: true, label: wanIface,
      bandwidthMbps: wanT ? Number((wanT.rxMbps + wanT.txMbps).toFixed(2)) : undefined,
    });
  }

  // bridges
  const bridgeRows = await db.networkResource.findMany({ where: { routerId: router.id, source: "bridges" } });
  const bridgeNames = bridgeRows.map((r) => parseJson<Record<string, string>>(r.data, {}).name).filter(Boolean) as string[];
  const deviceRows = await db.networkDevice.findMany({
    where: { routerId: router.id },
    orderBy: { lastSeen: "desc" },
    take: 400,
  });

  for (const b of bridgeNames) {
    const bt = traffic.get(b);
    nodes.push({ id: `bridge:${router.id}:${b}`, type: "bridge", label: b, online: runningIfaces.has(b) || undefined });
    edges.push({ from: `router:${router.id}`, to: `bridge:${router.id}:${b}`, kind: "bridge", bandwidthMbps: bt ? Number((bt.rxMbps + bt.txMbps).toFixed(2)) : undefined, inferred: false });
  }

  // APs: interfaces serving wireless clients
  const apNames = new Set<string>();
  for (const d of deviceRows) {
    if (d.accessPoint) apNames.add(d.accessPoint);
  }
  for (const ap of apNames) {
    const at = traffic.get(ap);
    const isBridgePort = bridgeNames.length > 0;
    const parentId = `router:${router.id}`;
    nodes.push({ id: `ap:${router.id}:${ap}`, type: "ap", label: ap, online: runningIfaces.has(ap) || undefined });
    edges.push({ from: parentId, to: `ap:${router.id}:${ap}`, kind: "wireless", bandwidthMbps: at ? Number((at.rxMbps + at.txMbps).toFixed(2)) : undefined, inferred: false });
    if (isBridgePort && bridgeNames[0]) {
      edges.push({ from: `ap:${router.id}:${ap}`, to: `bridge:${router.id}:${bridgeNames[0]}`, kind: "port", inferred: true });
    }
  }

  // ports seen in bridge hosts (physical switch ports carrying devices)
  const portNames = new Set<string>();
  for (const d of deviceRows) {
    if (d.interfaceName && !bridgeNames.includes(d.interfaceName) && !apNames.has(d.interfaceName) && !d.accessPoint) {
      portNames.add(d.interfaceName);
    }
  }

  for (const port of portNames) {
    const pt = traffic.get(port);
    if (!runningIfaces.has(port) && !traffic.has(port)) continue;
    nodes.push({ id: `port:${router.id}:${port}`, type: "port", label: port, online: runningIfaces.has(port) || undefined });
    edges.push({ from: `router:${router.id}`, to: `port:${router.id}:${port}`, kind: "port", bandwidthMbps: pt ? Number((pt.rxMbps + pt.txMbps).toFixed(2)) : undefined, inferred: false });
  }

  // devices
  const nodeIds = new Set<string>();
  for (const n of nodes) nodeIds.add(n.id);
  for (const d of deviceRows) {
    const label = d.customName || d.hostname || d.macAddress;
    const deviceId = `device:${d.id}`;
    nodes.push({
      id: deviceId,
      type: "device",
      label,
      ip: d.ipAddress ?? undefined,
      mac: d.macAddress,
      status: d.status,
      vlan: d.vlanId,
      deviceDbId: d.id,
      connectionType: d.connectionType,
      manufacturer: d.manufacturer ?? undefined,
      hostname: d.hostname ?? undefined,
      category: d.deviceCategory,
    });
    nodeIds.add(deviceId);
    let parent: string | null = null;
    let kind: TopoEdge["kind"] = "device";
    let inferred = false;
    if (d.accessPoint && apNames.has(d.accessPoint)) {
      parent = `ap:${router.id}:${d.accessPoint}`;
      kind = "wireless";
    } else if (d.interfaceName && bridgeNames.includes(d.interfaceName)) {
      parent = `bridge:${router.id}:${d.interfaceName}`;
    } else if (d.interfaceName && portNames.has(d.interfaceName)) {
      parent = `port:${router.id}:${d.interfaceName}`;
    } else if (d.interfaceName && runningIfaces.has(d.interfaceName)) {
      const pt = traffic.get(d.interfaceName);
      nodes.push({ id: `port:${router.id}:${d.interfaceName}`, type: "port", label: d.interfaceName, online: true });
      nodeIds.add(`port:${router.id}:${d.interfaceName}`);
      edges.push({ from: `router:${router.id}`, to: `port:${router.id}:${d.interfaceName}`, kind: "port", bandwidthMbps: pt ? Number((pt.rxMbps + pt.txMbps).toFixed(2)) : undefined, inferred: false });
      parent = `port:${router.id}:${d.interfaceName}`;
    }
    if (!parent || !nodeIds.has(parent)) {
      parent = `router:${router.id}`;
      inferred = true;
    }
    edges.push({ from: parent, to: deviceId, kind, inferred, bandwidthMbps: undefined, label: d.vlanId ? `VLAN ${d.vlanId}` : undefined });
  }

  // per-parent ok/warn/err counters
  const parentCounts = new Map<string, { ok: number; warn: number; err: number }>();
  for (const n of nodes.filter((x) => x.type === "device")) {
    const edge = edges.find((e) => e.to === n.id);
    if (!edge) continue;
    const c = parentCounts.get(edge.from) ?? { ok: 0, warn: 0, err: 0 };
    if (n.status === "online") c.ok++;
    else if (n.status === "idle" || n.status === "recently_disconnected" || n.status === "unknown") c.warn++;
    else c.err++;
    parentCounts.set(edge.from, c);
  }
  for (const n of nodes) {
    const c = parentCounts.get(n.id);
    if (c) n.counts = c;
  }

  return {
    routerId: router.id,
    routerName: router.name,
    networkName: `${router.identity || router.name} (${router.host})`,
    nodes,
    edges,
    lastSyncAt: router.lastSyncAt?.toISOString() ?? null,
    lastSyncOk: router.lastSyncOk,
    unreachable,
    statusMessage: router.statusMessage,
  };
}

/** Correlate LLDP/MNDP neighbors across routers to build inter-router links. */
async function buildInterRouterLinks(routers: any[]): Promise<TopoEdge[]> {
  const links: TopoEdge[] = [];
  const routerMap = new Map(routers.map((r) => [r.id, r]));

  for (const router of routers) {
    // Fetch LLDP/MNDP neighbors for this router
    const neighborRows = await db.networkResource.findMany({
      where: { routerId: router.id, source: "neighbors" },
    });
    for (const nr of neighborRows) {
      const n = parseJson<Record<string, string>>(nr.data, {});
      if (!n["mac-address"] && !n["ipv4-address"]) continue;

      // Try to match neighbor to another managed router
      let targetRouterId: string | null = null;
      let targetLabel = "Unknown Router";

      // Match by MAC address on router interfaces
      if (n["mac-address"]) {
        const mac = n["mac-address"].toLowerCase();
        for (const [rid, r] of routerMap) {
          if (rid === router.id) continue;
          // Check if this MAC matches any interface on the target router
          const ifaceRows = await db.networkResource.findMany({
            where: { routerId: rid, source: "interfaces" },
            take: 50,
          });
          for (const ir of ifaceRows) {
            const iface = parseJson<Record<string, string>>(ir.data, {});
            if (iface["mac-address"]?.toLowerCase() === mac || iface["default-mac-address"]?.toLowerCase() === mac) {
              targetRouterId = rid;
              targetLabel = r.identity || r.name;
              break;
            }
          }
          if (targetRouterId) break;
        }
      }

      // Match by IP address
      if (!targetRouterId && n["ipv4-address"]) {
        const ip = n["ipv4-address"].split("/")[0];
        for (const [rid, r] of routerMap) {
          if (rid === router.id) continue;
          if (r.host === ip) {
            targetRouterId = rid;
            targetLabel = r.identity || r.name;
            break;
          }
        }
      }

      if (targetRouterId) {
        const fromId = `router:${router.id}`;
        const toId = `router:${targetRouterId}`;
        // Avoid duplicate links (only add one direction)
        const existing = links.find((l) =>
          (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId)
        );
        if (!existing) {
          links.push({
            from: fromId,
            to: toId,
            kind: "router_link",
            inferred: false,
            label: n.interface ?? "LLDP/MNDP",
          });
        }
      }
    }
  }

  return links;
}

/** Build multi-router topology with inter-router links. */
export async function buildMultiRouterTopology(routerId?: string): Promise<MultiRouterTopology> {
  const routers = await db.router.findMany({
    where: routerId ? { id: routerId } : {},
    orderBy: { createdAt: "asc" },
  });

  const routerTopologies: RouterTopology[] = [];
  for (const router of routers) {
    routerTopologies.push(await buildSingleRouterTopology(router));
  }

  const interRouterLinks = await buildInterRouterLinks(routers);

  return {
    routers: routerTopologies,
    interRouterLinks,
    generatedAt: new Date().toISOString(),
  };
}

/** Save topology snapshot to database for historical playback. */
export async function saveTopologySnapshot(routerId: string, topology: MultiRouterTopology): Promise<void> {
  const routerTopology = topology.routers.find((r) => r.routerId === routerId);
  if (!routerTopology) return;

  const snapshotData = {
    nodes: routerTopology.nodes,
    edges: routerTopology.edges,
    interRouterLinks: topology.interRouterLinks,
    generatedAt: topology.generatedAt,
  };

  await db.topologySnapshot.create({
    data: {
      routerId,
      snapshot: snapshotData,
    },
  });
}

/** Get topology snapshots for historical playback. */
export async function getTopologySnapshots(routerId: string, limit = 50): Promise<any[]> {
  return db.topologySnapshot.findMany({
    where: { routerId },
    orderBy: { ts: "desc" },
    take: limit,
    select: { id: true, ts: true, snapshot: true },
  });
}

/** Get a specific topology snapshot. */
export async function getTopologySnapshot(snapshotId: string): Promise<any | null> {
  return db.topologySnapshot.findUnique({ where: { id: snapshotId } });
}

/** Legacy function for backward compatibility. */
export async function buildTopology(routerId?: string): Promise<{ routers: RouterTopology[]; generatedAt: string }> {
  const multi = await buildMultiRouterTopology(routerId);
  return { routers: multi.routers, generatedAt: multi.generatedAt };
}
