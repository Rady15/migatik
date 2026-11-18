/**
 * Unit tests for the Device Intelligence Engine — correlation + presence rules.
 * Run: bun run scripts/test-correlation.ts
 * Exit code 0 = all pass.
 */

import { correlateDevices, isNonDeviceMac, type CorrelationInput } from "../src/lib/discovery/correlate";
import { derivePresence } from "../src/lib/discovery/presence";
import { normalizeMac, normalizeIp, parseRosDuration, parseRosBytes, expiryFromDuration, ouiPrefixOf } from "../src/lib/discovery/normalize";
import { lookupManufacturer, ouiEntryCount } from "../src/lib/discovery/oui";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq<T>(a: T, b: T, name: string) { assert(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

console.log("\n=== normalize.ts ===");
eq(normalizeMac("AA-BB-CC-DD-EE-FF"), "aa:bb:cc:dd:ee:ff", "MAC dash → colon lowercase");
eq(normalizeMac("aabbccddeeff"), "aa:bb:cc:dd:ee:ff", "MAC plain hex → colon");
eq(normalizeMac("000000000000"), null, "all-zero MAC rejected");
eq(normalizeMac("garbage!!"), null, "invalid MAC rejected");
eq(normalizeIp("192.168.1.3"), "192.168.1.3", "valid IPv4");
eq(normalizeIp("999.1.1.1"), null, "invalid IPv4 rejected");
eq(parseRosDuration("1w2d3h4m5s"), 788645, "ROS duration parse (604800+172800+10800+240+5)");
eq(parseRosDuration("45s"), 45, "plain seconds");
eq(parseRosDuration("forever"), null, "forever → null");
eq(parseRosBytes("2456789"), 2456789, "API byte counters are plain integers");
eq(expiryFromDuration("1h")?.getTime() != null, true, "expiry derived from duration");
eq(ouiPrefixOf("aa:bb:cc:dd:ee:ff"), "AABBCC", "OUI prefix extraction");

console.log("\n=== oui.ts (real IEEE database) ===");
const n = ouiEntryCount();
assert(n > 30000, `OUI database loaded (${n} entries)`, "expected >30000 real IEEE entries");
const apple = lookupManufacturer("ac:de:48:00:11:22");
console.log(`  sample lookup ac:de:48 → ${apple.manufacturer ?? "unknown"}`);
const unknown = lookupManufacturer("ff:ff:ff:00:00:00");
assert(unknown.manufacturer === null, "unknown OUI → null (never guessed)");

console.log("\n=== correlate.ts ===");
const baseInput: CorrelationInput = {
  dhcpLeases: [
    { address: "192.168.1.101", mac: "aa:bb:cc:11:22:33", hostname: "iphone-ahmed", status: "bound", dynamic: true, blocked: false, disabled: false, raw: {} },
    { address: "192.168.1.110", mac: "bb:cc:dd:44:55:66", hostname: "office-pc", status: "bound", dynamic: false, blocked: false, disabled: false, raw: {} },
    { address: "192.168.1.150", mac: "ff:11:22:33:44:55", status: "waiting", dynamic: true, blocked: false, disabled: false, raw: {} },
  ],
  arpEntries: [
    { address: "192.168.1.101", mac: "aa:bb:cc:11:22:33", interface: "bridge", dynamic: true, complete: true, invalid: false, published: false, raw: {} },
    { address: "192.168.1.110", mac: "bb:cc:dd:44:55:66", interface: "ether2", dynamic: true, complete: true, invalid: false, published: false, raw: {} },
    { address: "192.168.1.99", mac: "01:00:5e:00:00:01", interface: "bridge", dynamic: true, complete: true, invalid: false, published: false, raw: {} },
  ],
  bridgeHosts: [
    { mac: "aa:bb:cc:11:22:33", bridge: "bridge", interface: "wlan1", dynamic: true, isLocal: false, externalFdb: false, raw: {} },
    { mac: "bb:cc:dd:44:55:66", bridge: "bridge", interface: "ether2", vlanId: 20, dynamic: true, isLocal: false, externalFdb: false, raw: {} },
    { mac: "d4:ca:6d:fe:00:01", bridge: "bridge", interface: "ether1", dynamic: true, isLocal: true, externalFdb: false, raw: {} },
  ],
  wireless: [
    { mac: "aa:bb:cc:11:22:33", apiPath: "wireless", interface: "wlan1", ssid: "Nyt-Net", signal: "-58dBm@HT20", txRate: "144Mbps", rxRate: "130Mbps", uptime: "2h13m", band: "2.4GHz", raw: {} },
  ],
  hotspotActive: [
    { username: "user1", ip: "192.168.1.160", mac: "12:34:56:78:9a:bc", bytesIn: 1000, bytesOut: 500, raw: {} },
  ],
  hotspotHosts: [{ mac: "12:34:56:78:9a:bc", ip: "192.168.1.160", interface: "wlan1" }],
  pppActive: [
    { username: "client1", service: "pppoe", callerId: "cc:dd:ee:77:88:99", address: "10.10.10.5", profile: "default", raw: {} },
  ],
  neighbors: [
    { mac: "d4:ca:6d:fe:00:02", identity: "sw-core", interface: "ether1", platform: "MikroTik", version: "7.14", board: " CRS328", discoveredBy: "mndp" },
  ],
};

{
  const devices = correlateDevices(baseInput);
  const byMac = new Map(devices.map((d) => [d.mac, d]));

  assert(devices.length === 7, "7 map entries — local router MAC stays flagged (excluded from inventory later)");
  assert(!byMac.has("01:00:5e:00:00:01"), "multicast MAC not treated as device");
  assert(byMac.get("d4:ca:6d:fe:00:01")?.isLocalDevice === true, "router local MAC flagged isLocalDevice");

  const phone = byMac.get("aa:bb:cc:11:22:33");
  assert(phone != null, "wifi phone correlated");
  assert(!!phone?.sources.includes("dhcp") && !!phone?.sources.includes("arp") && !!phone?.sources.includes("bridge") && !!phone?.sources.includes("wireless"), "phone merged from dhcp+arp+bridge+wireless (no duplicates)");
  eq(phone?.hostname ?? "", "iphone-ahmed", "phone hostname from DHCP");
  eq(phone?.ipAddress ?? "", "192.168.1.101", "phone IP");
  eq(phone?.connectionType ?? "", "wireless", "phone connectionType=wireless (active registration)");
  eq(phone?.accessPoint ?? "", "wlan1", "phone AP identified");
  assert(phone?.wirelessActiveNow === true, "phone wirelessActiveNow");

  const pc = byMac.get("bb:cc:dd:44:55:66");
  eq(pc?.vlanId ?? null, 20, "pc VLAN from bridge host");
  assert(pc?.wirelessActiveNow === false, "pc has no active session evidence");

  const waiting = byMac.get("ff:11:22:33:44:55");
  assert(waiting?.dhcpBoundNow === false && waiting?.dhcpStateNow === "waiting", "waiting lease: not bound, state preserved exactly");

  const ppp = byMac.get("cc:dd:ee:77:88:99");
  assert(ppp?.pppActiveNow === true && ppp?.connectionType === "pppoe", "pppoe caller-id correlated as pppoe device");
  eq(ppp?.ipAddress ?? "", "10.10.10.5", "pppoe assigned IP");

  const hs = byMac.get("12:34:56:78:9a:bc");
  assert(hs?.hotspotActiveNow === true && hs?.connectionType === "hotspot", "hotspot active correlated");
  eq(hs?.hotspotBytesIn ?? null, 1000, "hotspot bytes-in captured for live traffic");

  const neighbor = byMac.get("d4:ca:6d:fe:00:02");
  eq(neighbor?.neighborIdentity ?? "", "sw-core", "neighbor identity as hostname");
  assert(neighbor?.selfReportedOs === "MikroTik 7.14", "OS recorded ONLY from self-reported LLDP/MNDP");
}

console.log("\n=== presence.ts ===");
const NOW = 1_000_000_000;
const p = { now: NOW, activeFreshMs: 150_000, l2l3FreshMs: 120_000, graceMs: 300_000 };

{
  const r = derivePresence({ wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: true, sources: ["dhcp"] }, null, p);
  eq(r.status, "idle", "CRITICAL: DHCP bound alone is NEVER online → idle");
  assert(r.evidence.some((e) => e.includes("DHCP")), "evidence explains DHCP reasoning");
}
{
  const r = derivePresence({ wirelessActiveNow: true, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: true, sources: ["wireless", "dhcp"] }, null, p);
  eq(r.status, "online", "wireless registration → ONLINE");
}
{
  const r = derivePresence({ wirelessActiveNow: false, hotspotActiveNow: true, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: ["hotspot"] }, null, p);
  eq(r.status, "online", "hotspot session → ONLINE");
}
{
  const r = derivePresence({ wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: true, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: ["pppoe"] }, null, p);
  eq(r.status, "online", "ppp session → ONLINE");
}
{
  // was online 1 min ago, no active evidence now → recently_disconnected (grace 5 min)
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: [] },
    { status: "online", lastActive: NOW - 60_000, blocked: false },
    p,
  );
  eq(r.status, "recently_disconnected", "lost active evidence within grace → recently_disconnected");
}
{
  // grace expired → offline
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: ["dhcp"] },
    { status: "recently_disconnected", lastActive: NOW - 400_000, blocked: false },
    p,
  );
  eq(r.status, "offline", "grace expired with only historical sources → offline");
}
{
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: true, arpInvalidNow: false, bridgeDynamicNow: true, dhcpBoundNow: false, sources: ["arp", "bridge"] },
    { status: "idle", lastActive: NOW - 3600_000, blocked: false },
    p,
  );
  eq(r.status, "idle", "ARP complete + bridge dynamic (no session) → idle, not online");
}
{
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: [] },
    null,
    p,
  );
  eq(r.status, "unknown", "no evidence at all → honest UNKNOWN");
}
{
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: [] },
    { status: "offline", lastActive: null, blocked: true },
    p,
  );
  eq(r.status, "blocked", "block rule overrides everything → blocked");
}
{
  // stale ARP-only device that was never active and has no fresh L2: stays offline after being seen
  const r = derivePresence(
    { wirelessActiveNow: false, hotspotActiveNow: false, pppActiveNow: false, arpCompleteNow: false, arpInvalidNow: false, bridgeDynamicNow: false, dhcpBoundNow: false, sources: ["arp"] },
    { status: "idle", lastActive: null, blocked: false },
    p,
  );
  eq(r.status, "offline", "previously seen, no fresh evidence → offline");
}

console.log("\n=== isNonDeviceMac ===");
assert(isNonDeviceMac("ff:ff:ff:ff:ff:ff"), "broadcast excluded");
assert(isNonDeviceMac("01:00:5e:11:22:33"), "IPv4 multicast excluded");
assert(isNonDeviceMac("33:33:00:00:00:01"), "IPv6 multicast excluded");
assert(!isNonDeviceMac("aa:bb:cc:dd:ee:ff"), "normal MAC kept");
assert(!isNonDeviceMac("ce:2d:11:22:33:44"), "randomized phone MAC kept (device)");

console.log(`\n=================================`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
