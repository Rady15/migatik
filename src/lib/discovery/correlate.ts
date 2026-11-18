/**
 * Device Intelligence Engine — CORRELATION (pure functions, unit-testable).
 *
 * Correlates DHCP leases, ARP entries, bridge hosts, wireless registrations
 * (legacy/wifi/CAPsMAN), hotspot actives, PPPoE actives and LLDP/MNDP neighbors
 * into ONE unified device record per physical device.
 *
 * Primary matching key: MAC address + Router (organization).
 * Secondary identifiers: IP, hostname, client-id, interface, VLAN, AP.
 * Duplicates are prevented by the (routerId, macAddress) unique key in the DB.
 *
 * HONESTY: the engine never invents data. Manufacturer comes from the local IEEE
 * OUI database (organization only). OS is recorded only when the device itself
 * self-reports it via LLDP/MNDP neighbor discovery.
 */

import { normalizeMac, normalizeIp } from "./normalize";
import type {
  NormalizedLease, NormalizedArp, NormalizedBridgeHost,
  NormalizedWireless, NormalizedHotspotActive, NormalizedPppActive,
} from "./collectors";

export interface NeighborInfo {
  mac?: string; identity?: string; interface?: string; platform?: string;
  version?: string; board?: string; discoveredBy?: string;
}

export interface CorrelationInput {
  dhcpLeases: NormalizedLease[];
  arpEntries: NormalizedArp[];
  bridgeHosts: NormalizedBridgeHost[];
  wireless: NormalizedWireless[];
  hotspotActive: NormalizedHotspotActive[];
  hotspotHosts: { mac?: string; ip?: string; interface?: string }[];
  pppActive: NormalizedPppActive[];
  neighbors: NeighborInfo[];
  /** Interfaces facing the upstream/WAN (from the 0.0.0.0/0 default route).
   *  ARP/bridge hosts seen only there are upstream infrastructure, NOT clients
   *  on the managed LAN — they must not become device records. */
  wanInterfaces?: string[];
}

/**
 * Detect upstream/WAN interface names from the default route (0.0.0.0/0).
 * Honest: derived from real RouterOS routing data, never guessed.
 */
export function detectWanInterfaces(
  routes: { data: string }[],
): string[] {
  const out = new Set<string>();
  for (const row of routes) {
    let r: Record<string, string>;
    try { r = JSON.parse(row.data || "{}"); } catch { continue; }
    if (r["dst-address"] !== "0.0.0.0/0") continue;
    // RouterOS: immediate-gw "192.168.1.1%in", vrf-interface "in", gateway "out"
    const gw = r["immediate-gw"] || "";
    const iface = (gw.includes("%") ? gw.split("%")[1] : r["vrf-interface"] || r["gateway"]) || "";
    if (iface && !/^\d+\.\d+\.\d+\.\d+$/.test(iface)) out.add(iface);
  }
  return [...out];
}

export interface SourceEvidence {
  state?: string;      // exactly what RouterOS reported (bound / complete / dynamic...)
  ip?: string;
  interface?: string;
  details?: string;    // e.g. SSID, signal
}

export interface CorrelatedDevice {
  mac: string;
  ipAddress: string | null;
  hostname: string | null;
  sources: string[];
  sourceDetails: Record<string, SourceEvidence>;
  connectionType: "wired" | "wireless" | "hotspot" | "pppoe" | "unknown";
  interfaceName: string | null;
  vlanId: number | null;
  accessPoint: string | null;
  isLocalDevice: boolean;
  selfReportedOs: string | null;   // only from LLDP/MNDP — never guessed
  selfReportedBoard: string | null;
  neighborIdentity: string | null;
  // presence inputs (raw booleans — status derivation lives in presence.ts)
  wirelessActiveNow: boolean;
  hotspotActiveNow: boolean;
  pppActiveNow: boolean;
  arpCompleteNow: boolean;
  arpInvalidNow: boolean;
  bridgeDynamicNow: boolean;
  dhcpBoundNow: boolean;
  dhcpStateNow: string | null;
  hotspotBytesIn: number | null;   // session counters for live traffic
  hotspotBytesOut: number | null;
}

/** Multicast / broadcast / IPv6 link-local discovery MACs are not devices. */
export function isNonDeviceMac(mac: string): boolean {
  const m = mac.toLowerCase();
  if (m === "ff:ff:ff:ff:ff:ff") return true;
  if (m.startsWith("01:00:5e")) return true;       // IPv4 multicast
  if (m.startsWith("33:33:")) return true;         // IPv6 multicast
  if (m.startsWith("01:80:c2")) return true;       // STP/LLDP controlled frames
  if (m.startsWith("cf:2d:") || m.startsWith("ce:2d:")) return false; // random MACs are still devices
  return false;
}

/**
 * True when the MAC is locally-administered (the U/L bit — bit 1 of the first
 * octet — is set). These are software-generated / randomized/private MACs, not
 * hardware OUI addresses. On their own (bridge-only FDB entries) they are not
 * reliable evidence of a real physical device.
 */
export function isLocallyAdministeredMac(mac: string): boolean {
  const first = mac.replace(/[^0-9a-f]/gi, "").slice(0, 2);
  if (first.length < 2) return false;
  const byte = parseInt(first, 16);
  if (Number.isNaN(byte)) return false;
  return (byte & 0x02) !== 0;
}

export function correlateDevices(input: CorrelationInput): CorrelatedDevice[] {
  const map = new Map<string, CorrelatedDevice>();
  const wanIfaces = new Set((input.wanInterfaces ?? []).map((s) => s.toLowerCase()));
  // Two independent flags (order-independent): a device is dropped only when
  // it has WAN evidence and NO LAN-grade evidence at all.
  const wanEvidence = new Set<string>();
  const lanEvidence = new Set<string>();
  const markWan = (mac: string | null | undefined, iface: string | null | undefined) => {
    if (!mac || !iface) return;
    const m = normalizeMac(mac);
    if (!m) return;
    if (wanIfaces.has(String(iface).toLowerCase()) || wanIfaces.has(String(iface))) wanEvidence.add(m);
  };
  const markLan = (mac: string | null | undefined) => {
    if (!mac) return;
    const m = normalizeMac(mac);
    if (m) lanEvidence.add(m);
  };

  const getOrCreate = (macRaw: string | null | undefined): CorrelatedDevice | null => {
    const mac = normalizeMac(macRaw);
    if (!mac || isNonDeviceMac(mac)) return null;
    let d = map.get(mac);
    if (!d) {
      d = {
        mac,
        ipAddress: null,
        hostname: null,
        sources: [],
        sourceDetails: {},
        connectionType: "unknown",
        interfaceName: null,
        vlanId: null,
        accessPoint: null,
        isLocalDevice: false,
        selfReportedOs: null,
        selfReportedBoard: null,
        neighborIdentity: null,
        wirelessActiveNow: false,
        hotspotActiveNow: false,
        pppActiveNow: false,
        arpCompleteNow: false,
        arpInvalidNow: false,
        bridgeDynamicNow: false,
        dhcpBoundNow: false,
        dhcpStateNow: null,
        hotspotBytesIn: null,
        hotspotBytesOut: null,
      };
      map.set(mac, d);
    }
    return d;
  };

  const addSource = (d: CorrelatedDevice, src: string, ev: SourceEvidence) => {
    if (!d.sources.includes(src)) d.sources.push(src);
    d.sourceDetails[src] = ev;
  };

  // --- DHCP leases (IP assignment evidence — NEVER online evidence) ---
  for (const l of input.dhcpLeases) {
    const d = getOrCreate(l.mac);
    if (!d) continue;
    markLan(l.mac); // a DHCP lease is real client-grade evidence
    addSource(d, "dhcp", { state: l.status, ip: l.address, interface: l.serverName });
    if (l.status === "bound") { d.dhcpBoundNow = true; d.dhcpStateNow = l.status; }
    else if (!d.dhcpStateNow) d.dhcpStateNow = l.status;
    if (!d.hostname && l.hostname) d.hostname = l.hostname;
    // DHCP "server" is the DHCP server name, not an interface — only use it as interface hint
    if (!d.interfaceName && l.serverName && !d.sources.includes("arp")) d.interfaceName = null;
  }

  // --- ARP (L3 reachability evidence) ---
  for (const a of input.arpEntries) {
    const d = getOrCreate(a.mac);
    if (!d) continue;
    markWan(a.mac, a.interface);
    addSource(d, "arp", { state: a.complete ? "complete" : a.invalid ? "invalid" : "incomplete", ip: a.address, interface: a.interface });
    if (a.complete) d.arpCompleteNow = true;
    if (a.invalid) d.arpInvalidNow = true;
    if (!d.interfaceName && a.interface) d.interfaceName = a.interface;
    if (!d.ipAddress && a.address) d.ipAddress = a.address;
    if (a.dynamic === false) d.sources.push("arp_static");
  }

  // --- Bridge hosts (L2 connectivity evidence) ---
  for (const b of input.bridgeHosts) {
    const d = getOrCreate(b.mac);
    if (!d) continue;
    if (b.isLocal) { d.isLocalDevice = true; continue; }
    // If a bridge host is seen on a WAN interface, mark it as upstream-only.
    // If it also appears on a LAN interface, markLan clears the flag.
    markWan(b.mac, b.interface);
    addSource(d, "bridge", { state: b.dynamic ? "dynamic" : "static", interface: b.interface });
    if (b.dynamic) d.bridgeDynamicNow = true;
    if (b.interface) d.interfaceName = b.interface;
    if (b.vlanId) d.vlanId = b.vlanId;
  }

  // --- Wireless (legacy + wifi + CAPsMAN) — direct active-session evidence ---
  for (const w of input.wireless) {
    const d = getOrCreate(w.mac);
    if (!d) continue;
    markLan(w.mac);
    const srcName = w.apiPath; // wireless | wifi | capsman
    addSource(d, srcName, {
      state: "registered",
      interface: w.interface,
      details: [w.ssid ? `SSID ${w.ssid}` : "", w.signal ? `signal ${w.signal}` : "", w.band || ""].filter(Boolean).join(" · "),
    });
    d.wirelessActiveNow = true;
    if (w.interface) { d.accessPoint = w.interface; d.interfaceName = w.interface; }
    if (w.band && !d.vlanId && w.raw["vlan-id"]) d.vlanId = parseInt(w.raw["vlan-id"], 10) || null;
  }

  // --- Hotspot active sessions ---
  for (const h of input.hotspotActive) {
    if (h.mac) {
      const d = getOrCreate(h.mac);
      if (d) {
        markLan(h.mac);
        addSource(d, "hotspot", { state: "active", ip: h.ip ?? undefined });
        d.hotspotActiveNow = true;
        if (h.ip) d.ipAddress = h.ip;
        d.hotspotBytesIn = h.bytesIn ?? null;
        d.hotspotBytesOut = h.bytesOut ?? null;
      }
    }
    // hotspot without MAC still matters for session lists, but cannot create a device record
  }

  // --- Hotspot host table (IP↔MAC mapping even for non-authenticated devices) ---
  for (const hh of input.hotspotHosts) {
    const d = getOrCreate(hh.mac);
    if (!d) continue;
    markLan(hh.mac);
    if (!d.sources.includes("hotspot_host")) d.sources.push("hotspot_host");
    if (!d.ipAddress && hh.ip) d.ipAddress = hh.ip;
    const ev = d.sourceDetails["hotspot_host"] ?? { state: "seen" };
    if (hh.ip) ev.ip = hh.ip;
    if (hh.interface) ev.interface = hh.interface;
    d.sourceDetails["hotspot_host"] = ev;
  }

  // --- PPP active sessions ---
  for (const p of input.pppActive) {
    // PPPoE caller-id is the CPE MAC — only correlate when it's a real MAC
    const d = getOrCreate(p.callerId);
    if (d) {
      markLan(p.callerId);
      addSource(d, "pppoe", { state: "active", ip: p.address ?? undefined, details: `${p.username}${p.profile ? ` (${p.profile})` : ""}` });
      d.pppActiveNow = true;
      if (p.address) d.ipAddress = p.address;
    }
    // Sessions without a MAC caller-id (L2TP etc.) are listed as sessions only
  }

  // --- Neighbors (LLDP/MNDP — devices self-identify; hostname + OS are reliable here) ---
  for (const n of input.neighbors) {
    const d = getOrCreate(n.mac);
    if (!d) continue;
    markLan(n.mac);
    addSource(d, "neighbor", { interface: n.interface, details: n.identity });
    if (!d.hostname && n.identity) d.hostname = n.identity;
    if (n.identity) d.neighborIdentity = n.identity;
    if (n.platform && n.version) d.selfReportedOs = `${n.platform} ${n.version}`;
    else if (n.platform) d.selfReportedOs = n.platform;
    if (n.board) d.selfReportedBoard = n.board;
    if (n.interface && !d.interfaceName) d.interfaceName = n.interface;
  }

  // --- Final classification per device ---
  for (const d of map.values()) {
    // connection type: strongest active evidence wins
    if (d.pppActiveNow) d.connectionType = "pppoe";
    else if (d.hotspotActiveNow) d.connectionType = "hotspot";
    else if (d.wirelessActiveNow) d.connectionType = "wireless";
    else if (d.arpCompleteNow || d.bridgeDynamicNow || d.dhcpBoundNow) d.connectionType = "wired";
    else d.connectionType = "unknown";

    // IP priority: session > dhcp bound > arp > anything
    const dhcpBound = input.dhcpLeases.find(
      (l) => normalizeMac(l.mac) === d.mac && l.status === "bound",
    );
    if (!d.ipAddress && dhcpBound) d.ipAddress = dhcpBound.address;
  }

  // --- Drop upstream-only devices ----------------------------------------
  // A MAC seen ONLY via ARP/bridge on the WAN (default-route) interface is
  // upstream infrastructure (e.g. the ISP router 192.168.1.1), NOT a client
  // on the managed network. Genuine clients always have LAN-grade evidence
  // (hotspot / wireless / pppoe / DHCP lease / neighbor / LAN-side ARP), which
  // markLan() above clears from the wanOnly flag.
  const result: CorrelatedDevice[] = [];
  for (const d of map.values()) {
    // Upstream-only devices (WAN default-route interface, no LAN evidence)
    if (wanIfaces.size > 0 && wanEvidence.has(d.mac) && !lanEvidence.has(d.mac)) continue;
    // Bridge-only FDB entries with a locally-administered (randomized/private)
    // MAC are not reliable evidence of a real device. A randomized MAC is kept
    // when there is stronger evidence (hotspot/wireless/pppoe/DHCP/neighbor).
    const onlyBridge = d.sources.length === 1 && d.sources[0] === "bridge";
    if (onlyBridge && isLocallyAdministeredMac(d.mac)) continue;
    result.push(d);
  }
  return result;
}

/** Build a MAC↔IP map from hotspot host rows for history enrichment. */
export function hotspotHostIpMap(rows: { mac?: string; ip?: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const mac = normalizeMac(r.mac);
    const ip = normalizeIp(r.ip);
    if (mac && ip && !m.has(mac)) m.set(mac, ip);
  }
  return m;
}
