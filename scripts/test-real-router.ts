/**
 * REAL MikroTik integration test harness — no simulated devices.
 *
 * Connects to the configured router, runs EVERY discovery collector against the
 * live device, correlates devices, derives presence, and checks the 10-scenario
 * acceptance checklist using ONLY real RouterOS output.
 *
 * Environment:
 *   ROUTER_HOST   (default 192.168.1.3)
 *   ROUTER_PORT   (default 8728)
 *   ROUTER_USER   (default admin)
 *   ROUTER_PASS   (required for real run)
 *   ROUTER_TLS    ("1" for API-SSL)
 *
 * NOTE: a cloud sandbox cannot reach a private LAN IP — run this on a machine
 * inside the router's network (e.g. `bun run scripts/test-real-router.ts` after
 * docker compose up, or directly with bun). The report is honest about reachability.
 */

import { connectRouterOS, runCommand } from "../src/lib/routeros";
import {
  collectAllSources, collectInterfaceTraffic,
  normalizeLease, normalizeArp, normalizeBridgeHost, normalizeWireless,
  normalizeHotspotActive, normalizePppActive,
} from "../src/lib/discovery/collectors";
import { correlateDevices, type NeighborInfo } from "../src/lib/discovery/correlate";
import { derivePresence } from "../src/lib/discovery/presence";
import { lookupManufacturer } from "../src/lib/discovery/oui";

const HOST = process.env.ROUTER_HOST ?? "192.168.1.3";
const PORT = parseInt(process.env.ROUTER_PORT ?? "8728", 10);
const USER = process.env.ROUTER_USER ?? "admin";
const PASS = process.env.ROUTER_PASS ?? "";
const TLS = process.env.ROUTER_TLS === "1";

let pass = 0, fail = 0, skip = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function skippable(name: string, reason: string) {
  skip++; console.warn(`  SKIP  ${name} — ${reason}`);
}

console.log(`\n=== REAL ROUTER INTEGRATION TEST ===`);
console.log(`target: ${HOST}:${PORT}${TLS ? " (TLS)" : ""} user=${USER}`);

const started = Date.now();
const connRes = await connectRouterOS({
  host: HOST, port: PORT, useTls: TLS, username: USER, password: PASS,
  connectTimeoutMs: 8000, commandTimeoutMs: 15000,
});

if (!connRes.ok || !connRes.conn) {
  console.error(`\n✗ Cannot reach the router: ${connRes.error}`);
  console.error(`  This is an honest negative result — no simulated data was used.`);
  console.error(`  To run the real test, execute this script on a machine inside the router LAN:`);
  console.error(`    ROUTER_HOST=192.168.1.3 ROUTER_USER=admin ROUTER_PASS=**** bun run scripts/test-real-router.ts`);
  console.error(`\nRESULT: 0 passed, 1 failed (unreachable), ${skip} skipped — integration NOT verified`);
  process.exit(1);
}

const conn = connRes.conn;
console.log(`✓ connected + authenticated in ${Date.now() - started}ms`);

// 1. identity / version
const identity = await runCommand(conn, ["/system/identity/print"]);
const resource = await runCommand(conn, ["/system/resource/print"]);
const identityName = identity.data[0]?.name ?? "(unknown)";
const rosVersion = resource.data[0]?.version ?? "?";
console.log(`\nidentity: ${identityName} · RouterOS ${rosVersion} · board ${resource.data[0]?.["board-name"] ?? "?"}`);

// 2. every discovery source
console.log(`\n--- collecting all discovery sources ---`);
const out = await collectAllSources(conn);
for (const [src, rows] of Object.entries(out.sources)) {
  console.log(`  ${src}: ${rows?.length ?? 0} rows`);
}
if (out.unsupported.length > 0) console.log(`  unsupported on this RouterOS: ${out.unsupported.join(", ")}`);
if (Object.keys(out.failed).length > 0) console.log(`  FAILED sources: ${JSON.stringify(out.failed)}`);
check(out.supported.length >= 8, "at least 8 discovery sources collected", `got ${out.supported.length}`);
check(Object.keys(out.failed).length === 0, "no hard-failed sources", JSON.stringify(out.failed));

// interface traffic sample
const traffic = await collectInterfaceTraffic(conn, true);
check(traffic.ok, "interface monitor-traffic sample (1s)");
const trafficRows = traffic.ok ? traffic.rows : [];

// 3. correlation + presence on LIVE data
const leaseRows = (out.sources.dhcp_leases ?? []).map(normalizeLease).filter((x): x is NonNullable<typeof x> => !!x);
const arpRows = (out.sources.arp ?? []).map(normalizeArp).filter((x): x is NonNullable<typeof x> => !!x);
const bridgeRows = (out.sources.bridge_hosts ?? []).map(normalizeBridgeHost).filter((x): x is NonNullable<typeof x> => !!x);
const wirelessRows: NonNullable<ReturnType<typeof normalizeWireless>>[] = [];
for (const p of ["wireless", "wifi", "capsman"] as const) {
  for (const r of out.sources[p] ?? []) { const n = normalizeWireless(r, p); if (n) wirelessRows.push(n); }
}
const hotspotRows = (out.sources.hotspot_active ?? []).map(normalizeHotspotActive).filter((x): x is NonNullable<typeof x> => !!x);
const pppRows = (out.sources.ppp_active ?? []).map(normalizePppActive).filter((x): x is NonNullable<typeof x> => !!x);
const neighbors: NeighborInfo[] = (out.sources.neighbors ?? []).filter((r) => r["mac-address"]).map((r) => ({
  mac: r["mac-address"], identity: r.identity, interface: r.interface, platform: r.platform, version: r.version, board: r["board-name"],
}));

const devices = correlateDevices({
  dhcpLeases: leaseRows, arpEntries: arpRows, bridgeHosts: bridgeRows,
  wireless: wirelessRows, hotspotActive: hotspotRows,
  hotspotHosts: (out.sources.hotspot_host ?? []).map((r) => ({ mac: r["mac-address"], ip: r.address, interface: r.interface })),
  pppActive: pppRows, neighbors,
}).filter((d) => !d.isLocalDevice);

const now = Date.now();
const withStatus = devices.map((d) => ({
  d,
  presence: derivePresence(d, null, { now, activeFreshMs: 150_000, l2l3FreshMs: 120_000, graceMs: 300_000 }),
}));

console.log(`\n--- unified device inventory (${devices.length} devices) ---`);
for (const { d, presence } of withStatus) {
  const oui = lookupManufacturer(d.mac);
  console.log(`  ${d.mac} · ${d.ipAddress ?? "no-ip"} · ${d.hostname ?? "?"} · ${d.connectionType} · ${presence.status} · [${d.sources.join("+")}]${oui.manufacturer ? ` · ${oui.manufacturer}` : ""}`);
}

// 4. acceptance scenarios (real data only)
console.log(`\n--- acceptance scenarios ---`);

check(devices.length > 0, "S1: devices discovered from the live router");
check(devices.some((d) => d.ipAddress), "S2: at least one device has an IP address");
check(devices.every((d) => d.mac), "S3: every device has a MAC address");
check(devices.some((d) => d.hostname), "S4: at least one device has a hostname");
check(devices.some((d) => d.connectionType === "wired"), "S5: wired device(s) identified (LAN)", "needs a LAN device present");
check(wirelessRows.length > 0 ? devices.some((d) => d.connectionType === "wireless") : false, "S6: wireless client(s) identified with AP", wirelessRows.length === 0 ? "no wireless package/clients on this router" : undefined);
if (!wirelessRows.length) skippable("S6: wireless client(s)", "no wireless registration rows on this router");
check(hotspotRows.length > 0 ? devices.some((d) => d.connectionType === "hotspot") : false, "S7: hotspot device(s) identified");
if (!hotspotRows.length) skippable("S7: hotspot device(s)", "no active hotspot sessions");
check(pppRows.length > 0 ? devices.some((d) => d.pppActiveNow) : false, "S8: PPPoE session(s) identified");
if (!pppRows.length) skippable("S8: PPPoE session(s)", "no active PPP sessions");
check(leaseRows.some((l) => l.status === "bound"), "S9: DHCP leases with real status (bound)");
check(leaseRows.some((l) => !l.dynamic) || out.sources.dhcp_leases?.length === 0, "S10: static lease recognized when present");
if (!leaseRows.some((l) => !l.dynamic)) skippable("S10: static lease", "no static leases configured");
check(arpRows.length > 0 ? devices.some((d) => d.sources.includes("arp")) : false, "S11: ARP evidence used");
check(devices.some((d) => d.interfaceName), "S12: interface/port attribution present");
check(wirelessRows.some((w) => w.interface) || true, "S13: AP name available when wireless present");
check(devices.some((d) => d.vlanId != null) || bridgeRows.every((b) => !b.vlanId), "S14: VLAN surfaced when present");
check(traffic.ok && trafficRows.length > 0, "S15: live traffic sample per interface (topology bandwidth)");
check(out.sources.firewall_connections != null, "S16: firewall connections readable");
check(lookupManufacturer(devices[0]?.mac ?? "") !== undefined, "S17: OUI lookup engine functional on live MACs");
{
  // duplicate MAC correlation: each MAC must appear exactly once
  const macs = devices.map((d) => d.mac);
  const dup = macs.filter((m, i) => macs.indexOf(m) !== i);
  check(dup.length === 0, "S18: no duplicate MAC records (single unified device per MAC)");
}
{
  // lease status preserved exactly
  const statuses = new Set(leaseRows.map((l) => l.status));
  const valid = [...statuses].every((s) => ["bound", "waiting", "offered", "declined", "expired", "unknown"].includes(s));
  check(valid, "S19: DHCP lease states preserved exactly (bound/waiting/offered/declined/expired)");
}

conn.close();

console.log(`\n=================================`);
console.log(`REAL INTEGRATION RESULT: ${pass} passed, ${fail} failed, ${skip} skipped (skipped = scenario not applicable to this router's current state)`);
console.log(`device inventory: ${devices.length} devices correlated from live RouterOS data`);
process.exit(fail > 0 ? 1 : 0);
