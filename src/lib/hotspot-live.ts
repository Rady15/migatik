import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";

/**
 * Live Hotspot tables — read straight from RouterOS on every poll.
 *
 * The discovery sync writes a snapshot into the DB, which is fine for the
 * inventory, but the operator asked to watch Hotspot Active / Hosts / Bindings
 * in real time and to never see a device that is already disconnected. So this
 * module never touches the cached tables: it prints the live menus and returns
 * only what the router reports right now.
 */

export interface HotspotLiveActive {
  id: string;
  routerId: string;
  routerName: string;
  user: string;
  address: string | null;
  mac: string | null;
  server: string | null;
  loginBy: string | null;
  uptime: string | null;
  durationSec: number;
  bytesIn: number;
  bytesOut: number;
  comment: string | null;
}

export interface HotspotLiveHost {
  id: string;
  routerId: string;
  routerName: string;
  mac: string;
  address: string | null;
  toAddress: string | null;
  server: string | null;
  uptime: string | null;
  durationSec: number;
  bytesIn: number;
  bytesOut: number;
  authorized: boolean;
  bypassed: boolean;
}

export interface HotspotLiveBinding {
  id: string;
  routerId: string;
  routerName: string;
  mac: string | null;
  address: string | null;
  toAddress: string | null;
  server: string | null;
  type: string;
  disabled: boolean;
  comment: string | null;
  /** true when the binding MAC is currently present in the live host/active table */
  connected: boolean;
}

export interface HotspotLivePayload {
  active: HotspotLiveActive[];
  hosts: HotspotLiveHost[];
  bindings: HotspotLiveBinding[];
  counts: {
    active: number;
    hosts: number;
    bindings: number;
    connectedBindings: number;
  };
  routers: { id: string; name: string; status: string }[];
  errors: { router: string; error: string }[];
  fetchedAt: string;
}

function parseUptime(value?: string): number {
  if (!value) return 0;
  let sec = 0;
  const re = /(\d+)(w|d|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const n = Number(m[1]);
    const mult = m[2] === "w" ? 604800 : m[2] === "d" ? 86400 : m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
    sec += n * mult;
  }
  return sec;
}

function mb(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round((n / 1048576) * 100) / 100 : 0;
}

/** RouterOS marks booleans as "true"/"false" strings, and presence-only flags are empty or "true". */
function flag(value?: string): boolean {
  return value === "true" || value === "yes" || value === "";
}

export async function readHotspotLive(routerIds?: string[]): Promise<HotspotLivePayload> {
  const out: HotspotLivePayload = {
    active: [],
    hosts: [],
    bindings: [],
    counts: { active: 0, hosts: 0, bindings: 0, connectedBindings: 0 },
    routers: [],
    errors: [],
    fetchedAt: new Date().toISOString(),
  };

  const filter = routerIds && routerIds.length > 0 && !routerIds.includes("all") ? { id: { in: routerIds } } : {};
  const routers = await db.router.findMany({
    where: { isDemo: false, ...filter },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true, apiUsername: true, apiPasswordEnc: true, connectionMethod: true, agentId: true, status: true },
  });
  out.routers = routers.map((r) => ({ id: r.id, name: r.name, status: r.status }));

  for (const router of routers) {
    const res = await withRouterRow(
      router,
      async (conn) => {
        const active = await runCommand(conn, ["/ip/hotspot/active/print"]);
        const hosts = await runCommand(conn, ["/ip/hotspot/host/print"]);
        // RouterOS v7 menu path. Older builds exposed the same table under
        // /ip/hotspot/binding — fall back only when the modern path fails.
        let bindings = await runCommand(conn, ["/ip/hotspot/ip-binding/print"]);
        if (!bindings.ok) {
          const legacy = await runCommand(conn, ["/ip/hotspot/binding/print"]);
          if (legacy.ok) bindings = legacy;
        }
        return { active, hosts, bindings };
      },
      { connectTimeoutMs: 5000, commandTimeoutMs: 8000 },
    );

    if (!res.ok || !res.value) {
      out.errors.push({ router: router.name, error: res.error ?? "فشل قراءة بيانات Hotspot" });
      continue;
    }

    const { active, hosts, bindings } = res.value;
    if (!active.ok) out.errors.push({ router: router.name, error: active.error ?? "فشل قراءة جلسات Hotspot" });

    const connectedMacs = new Set<string>();

    for (const row of active.ok ? active.data : []) {
      const mac = (row["mac-address"] ?? "").trim().toLowerCase();
      if (mac) connectedMacs.add(mac);
      const uptime = row.uptime ?? row["session-time-left"] ?? null;
      out.active.push({
        id: row[".id"] ?? `${router.id}:${row.user ?? row["mac-address"] ?? ""}`,
        routerId: router.id,
        routerName: router.name,
        user: row.user ?? row["mac-address"] ?? "—",
        address: row.address ?? null,
        mac: row["mac-address"] ?? null,
        server: row.server ?? null,
        loginBy: row["login-by"] ?? null,
        uptime,
        durationSec: parseUptime(uptime ?? undefined),
        bytesIn: mb(row["bytes-in"]),
        bytesOut: mb(row["bytes-out"]),
        comment: row.comment ?? null,
      });
    }

    for (const row of hosts.ok ? hosts.data : []) {
      const mac = (row["mac-address"] ?? "").trim();
      if (!mac) continue;
      connectedMacs.add(mac.toLowerCase());
      out.hosts.push({
        id: row[".id"] ?? `${router.id}:${mac}`,
        routerId: router.id,
        routerName: router.name,
        mac,
        address: row.address ?? row["to-address"] ?? null,
        toAddress: row["to-address"] ?? null,
        server: row.server ?? null,
        uptime: row.uptime ?? null,
        durationSec: parseUptime(row.uptime),
        bytesIn: mb(row["bytes-in"]),
        bytesOut: mb(row["bytes-out"]),
        authorized: flag(row.authorized),
        bypassed: flag(row.bypassed),
      });
    }

    for (const row of bindings.ok ? bindings.data : []) {
      const mac = (row["mac-address"] ?? "").trim();
      out.bindings.push({
        id: row[".id"] ?? `${router.id}:${mac || row.address || row.comment || ""}`,
        routerId: router.id,
        routerName: router.name,
        mac: mac || null,
        address: row.address ?? null,
        toAddress: row["to-address"] ?? null,
        server: row.server ?? null,
        type: row.type ?? "regular",
        disabled: row.disabled === "true",
        comment: row.comment ?? null,
        connected: Boolean(mac && connectedMacs.has(mac.toLowerCase())),
      });
    }
  }

  out.counts.active = out.active.length;
  out.counts.hosts = out.hosts.length;
  out.counts.bindings = out.bindings.length;
  out.counts.connectedBindings = out.bindings.filter((b) => b.connected).length;
  return out;
}
