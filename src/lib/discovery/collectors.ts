/**
 * RouterOS discovery collectors — REAL API integration.
 * Every collector maps 1:1 to a documented RouterOS menu and stores exactly
 * what the router reports. Menus that don't exist on the target RouterOS
 * version (e.g. /interface/wifi on v6) are reported as UNSUPPORTED, never failed.
 */

import { runCommand, type RosConnection } from "@/lib/routeros";
import { bool, normalizeIp, normalizeMac, parseRosDuration, expiryFromDuration } from "./normalize";

export type DiscoverySource =
  | "dhcp_leases" | "dhcp_servers" | "dhcp_networks" | "arp" | "bridge_hosts" | "bridges"
  | "wireless" | "wifi" | "capsman" | "capsman_caps" | "hotspot_active" | "hotspot_host"
  | "ppp_active" | "ppp_secrets" | "ppp_profiles" | "interfaces" | "addresses"
  | "neighbors" | "routes" | "firewall_connections" | "address_lists" | "interface_traffic";

export interface CollectorResult {
  ok: boolean;
  unsupported?: boolean;
  rows: Record<string, string>[];
  error?: string;
}

export interface CollectorsOutput {
  sources: Partial<Record<DiscoverySource, Record<string, string>[]>>;
  supported: DiscoverySource[];
  unsupported: DiscoverySource[];
  failed: Partial<Record<DiscoverySource, string>>;
}

/** Run one collector command; interpret "bad command name" as unsupported menu. */
async function collect(conn: RosConnection, words: string[], timeoutMs = 12000): Promise<CollectorResult> {
  try {
    const res = await runCommand(conn, words, timeoutMs);
    if (!res.ok) {
      const msg = res.error ?? "unknown error";
      if (/bad command name|bad command|no such item|no such command|no such directory|unknown parameter|do not exist/i.test(msg)) {
        return { ok: true, unsupported: true, rows: [] };
      }
      return { ok: false, rows: [], error: msg };
    }
    return { ok: true, rows: res.data };
  } catch (e) {
    return { ok: false, rows: [], error: (e as Error).message };
  }
}

// ---------------- A. DHCP Leases ----------------
export interface NormalizedLease {
  rosId?: string; address: string; mac: string; hostname?: string; serverName?: string;
  status: string; dynamic: boolean; blocked: boolean; disabled: boolean;
  expiresAt?: Date | null; lastSeen?: Date; addressPool?: string; clientId?: string; comment?: string;
  raw: Record<string, string>;
}

export function normalizeLease(r: Record<string, string>): NormalizedLease | null {
  const address = normalizeIp(r.address);
  const mac = normalizeMac(r["mac-address"]);
  if (!address || !mac) return null;
  return {
    rosId: r[".id"],
    address,
    mac,
    hostname: r["host-name"] || r.hostname || undefined,
    serverName: r.server || r["dhcp-server"] || undefined,
    // RouterOS reports bound/waiting/offered/declined via flags + status; keep EXACT value
    status: (r.status || r.state || "unknown").toLowerCase(),
    dynamic: bool(r.dynamic),
    blocked: bool(r.blocked),
    disabled: bool(r.disabled),
    expiresAt: expiryFromDuration(r["expires-after"]),
    lastSeen: r["last-seen"] ? new Date() : undefined, // duration-since — refreshed on every sync
    addressPool: r["address-pool"] || undefined,
    clientId: r["client-id"] || undefined,
    comment: r.comment || undefined,
    raw: r,
  };
}

// ---------------- B. ARP ----------------
export interface NormalizedArp {
  rosId?: string; address: string; mac?: string; interface?: string;
  dynamic: boolean; complete: boolean; invalid: boolean; published: boolean; comment?: string;
  raw: Record<string, string>;
}

export function normalizeArp(r: Record<string, string>): NormalizedArp | null {
  const address = normalizeIp(r.address);
  if (!address) return null;
  return {
    rosId: r[".id"],
    address,
    mac: normalizeMac(r["mac-address"]) ?? undefined,
    interface: r.interface || undefined,
    dynamic: bool(r.dynamic),
    complete: bool(r.complete),
    invalid: bool(r.invalid),
    published: bool(r.published),
    comment: r.comment || undefined,
    raw: r,
  };
}

// ---------------- C. Bridge hosts ----------------
export interface NormalizedBridgeHost {
  rosId?: string; mac: string; bridge?: string; interface?: string; vlanId?: number;
  isLocal: boolean; dynamic: boolean; externalFdb: boolean; raw: Record<string, string>;
}

export function normalizeBridgeHost(r: Record<string, string>): NormalizedBridgeHost | null {
  const mac = normalizeMac(r["mac-address"]);
  if (!mac) return null;
  return {
    rosId: r[".id"],
    mac,
    bridge: r.bridge || undefined,
    interface: r.interface || r["on-interface"] || undefined,
    vlanId: r["vlan-id"] ? parseInt(r["vlan-id"], 10) || undefined : undefined,
    isLocal: bool(r.local),
    dynamic: bool(r.dynamic),
    externalFdb: bool(r["external-fdb"]),
    raw: r,
  };
}

// ---------------- D. Wireless (legacy + wifi + CAPsMAN) ----------------
export interface NormalizedWireless {
  rosId?: string; mac: string; apiPath: "wireless" | "wifi" | "capsman";
  interface?: string; radioName?: string; ssid?: string; signal?: string;
  txRate?: string; rxRate?: string; uptime?: string; band?: string;
  rxSignalCh?: string; registeredAt?: Date; raw: Record<string, string>;
}

export function normalizeWireless(r: Record<string, string>, apiPath: NormalizedWireless["apiPath"]): NormalizedWireless | null {
  const mac = normalizeMac(r["mac-address"]);
  if (!mac) return null;
  return {
    rosId: r[".id"],
    mac,
    apiPath,
    interface: r.interface || undefined,
    radioName: r["radio-name"] || r["called-station-id"] || undefined,
    ssid: r.ssid || undefined,
    signal: r["signal-strength"] || r.signal || undefined,
    txRate: r["tx-rate"] || r["tx-rate-set"] || undefined,
    rxRate: r["rx-rate"] || r["rx-rate-set"] || undefined,
    uptime: r.uptime || undefined,
    band: r.band || undefined,
    rxSignalCh: r["rx-signal"] || r["signal-to-noise"] || undefined,
    registeredAt: r["uptime"] ? new Date(Date.now() - (parseRosDuration(r.uptime) ?? 0) * 1000) : undefined,
    raw: r,
  };
}

// ---------------- E. Hotspot active ----------------
export interface NormalizedHotspotActive {
  rosId?: string; username: string; ip?: string; mac?: string; server?: string;
  uptime?: string; bytesIn?: number; bytesOut?: number; raw: Record<string, string>;
}

export function normalizeHotspotActive(r: Record<string, string>): NormalizedHotspotActive | null {
  if (!r.user) return null;
  return {
    rosId: r[".id"],
    username: r.user,
    ip: normalizeIp(r.address) ?? undefined,
    mac: normalizeMac(r["mac-address"]) ?? undefined,
    server: r.server || undefined,
    uptime: r.uptime || undefined,
    bytesIn: r["bytes-in"] ? parseInt(r["bytes-in"], 10) || undefined : undefined,
    bytesOut: r["bytes-out"] ? parseInt(r["bytes-out"], 10) || undefined : undefined,
    raw: r,
  };
}

// ---------------- F. PPP active ----------------
export interface NormalizedPppActive {
  rosId?: string; username: string; service?: string; callerId?: string;
  address?: string; profile?: string; uptime?: string; encoding?: string;
  raw: Record<string, string>;
}

export function normalizePppActive(r: Record<string, string>): NormalizedPppActive | null {
  if (!r.name) return null;
  return {
    rosId: r[".id"],
    username: r.name,
    service: r.service || undefined,
    callerId: normalizeMac(r["caller-id"]) ?? r["caller-id"] ?? undefined,
    address: normalizeIp(r.address) ?? undefined,
    profile: r.profile || undefined,
    uptime: r.uptime || undefined,
    encoding: r.encoding || undefined,
    raw: r,
  };
}

// ---------------- G. Interface traffic sample ----------------
export interface TrafficSample {
  interface: string; rxMbps: number; txMbps: number;
  rxPackets?: number; txPackets?: number; raw: Record<string, string>;
}

export function normalizeTraffic(r: Record<string, string>): TrafficSample | null {
  const iface = r.interface || r.name;
  if (!iface) return null;
  const rx = parseFloat(r["rx-bits-per-second"] ?? r["received-bits-per-second"] ?? "0") || 0;
  const tx = parseFloat(r["tx-bits-per-second"] ?? r["sent-bits-per-second"] ?? "0") || 0;
  return {
    interface: iface,
    rxMbps: rx / 1e6,
    txMbps: tx / 1e6,
    rxPackets: parseInt(r["rx-packets-per-second"] ?? "", 10) || undefined,
    txPackets: parseInt(r["tx-packets-per-second"] ?? "", 10) || undefined,
    raw: r,
  };
}

// ---------------- MAIN: run every discovery source against a live connection ----------------
export async function collectAllSources(conn: RosConnection): Promise<CollectorsOutput> {
  const out: CollectorsOutput = { sources: {}, supported: [], unsupported: [], failed: {} };
  const record = (src: DiscoverySource, res: CollectorResult) => {
    if (res.unsupported) { out.unsupported.push(src); return; }
    if (!res.ok) { out.failed[src] = res.error ?? "error"; return; }
    out.sources[src] = res.rows;
    out.supported.push(src);
  };

  // A. DHCP
  record("dhcp_leases", await collect(conn, ["/ip/dhcp-server/lease/print"]));
  record("dhcp_servers", await collect(conn, ["/ip/dhcp-server/print"]));
  record("dhcp_networks", await collect(conn, ["/ip/dhcp-server/network/print"]));

  // B. ARP
  record("arp", await collect(conn, ["/ip/arp/print"]));

  // C. Bridge (hosts are the L2 device evidence; bridges list gives topology)
  record("bridge_hosts", await collect(conn, ["/interface/bridge/host/print"]));
  record("bridges", await collect(conn, ["/interface/bridge/print"]));

  // D. Wireless — legacy package, modern wifi package, CAPsMAN (probe all three)
  record("wireless", await collect(conn, ["/interface/wireless/registration-table/print"]));
  record("wifi", await collect(conn, ["/interface/wifi/registration-table/print"]));
  record("capsman", await collect(conn, ["/caps-man/registration-table/print"]));
  record("capsman_caps", await collect(conn, ["/caps-man/remote-cap/print"]));

  // E. Hotspot
  record("hotspot_active", await collect(conn, ["/ip/hotspot/active/print"]));
  record("hotspot_host", await collect(conn, ["/ip/hotspot/host/print"]));

  // F. PPP
  record("ppp_active", await collect(conn, ["/ppp/active/print"]));
  record("ppp_secrets", await collect(conn, ["/ppp/secret/print"]));
  record("ppp_profiles", await collect(conn, ["/ppp/profile/print"]));

  // G. General network context
  record("interfaces", await collect(conn, ["/interface/print"]));
  record("addresses", await collect(conn, ["/ip/address/print"]));
  record("neighbors", await collect(conn, ["/ip/neighbor/print"]));
  record("routes", await collect(conn, ["/ip/route/print"]));
  record("firewall_connections", await collect(conn, ["/ip/firewall/connection/print"], 20000));
  record("address_lists", await collect(conn, ["/ip/firewall/address-list/print"]));

  return out;
}

/** One 1-second traffic sample across all interfaces (used for live traffic + topology links). */
export async function collectInterfaceTraffic(conn: RosConnection, once = true): Promise<CollectorResult> {
  // RouterOS CHR rejects `=interface=` empty / `=all` with "input does not match
  // any value of interface", and `=type=ether` is not a valid query word here.
  // So list ALL interfaces and filter in JS, then monitor each name explicitly.
  // Each reply carries REAL bits-per-second.
  const ifaces = await collect(conn, ["/interface/print"], 10000);
  const names = (ifaces.ok ? ifaces.rows : [])
    .filter((r) => !r.type || r.type === "ether")
    .map((r) => r.name)
    .filter((n): n is string => !!n && n !== "lo");

  const allRows: Record<string, string>[] = [];
  let lastError = "تعذر أخذ عينة الحركة";
  for (const name of names) {
    const res = await collect(conn, ["/interface/monitor-traffic", `=interface=${name}`, ...(once ? ["=once="] : [])], 15000);
    if (res.ok) allRows.push(...res.rows);
    else if (res.error) lastError = res.error;
  }
  if (allRows.length > 0) return { ok: true, rows: allRows };

  // Last resort: some RouterOS builds expose bits/sec directly in `print stats`.
  // NEVER fall back to `rx-byte`/`tx-byte` — those are cumulative byte counters,
  // not rates, and treating them as bps inflated every chart by ~1000x.
  const stats = await collect(conn, ["/interface/print", "stats"], 10000);
  const rateRows = (stats.ok ? stats.rows : []).filter(
    (r) => r["rx-bits-per-second"] !== undefined || r["tx-bits-per-second"] !== undefined,
  );
  if (rateRows.length > 0) {
    return { ok: true, rows: rateRows.map((r) => ({ ...r, interface: r.interface || r.name })) };
  }

  return { ok: false, rows: [], error: lastError };
}
