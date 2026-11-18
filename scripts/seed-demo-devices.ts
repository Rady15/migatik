/**
 * Clearly-labeled DEMO dataset for UI preview — NOT real discovery data.
 *
 * Creates a router with isDemo=true (excluded from the real scheduler) named
 * "[DEMO]" and inserts synthetic devices/leases/etc. Every record is visibly
 * marked DEMO. This exists ONLY so the interface can be evaluated without a
 * reachable MikroTik. Real discovery never uses this data.
 *
 * Run: bun run scripts/seed-demo-devices.ts
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

const DEMO_DEVICES: {
  mac: string; ip: string; hostname: string; manufacturer: string; category: string;
  connectionType: string; status: string; sources: string[]; interface?: string; ap?: string; vlan?: number;
}[] = [
  { mac: "aa:bb:cc:11:22:33", ip: "192.168.1.101", hostname: "DEMO-iphone-ahmed", manufacturer: "Apple, Inc.", category: "phone", connectionType: "wireless", status: "online", sources: ["wireless", "dhcp", "arp", "bridge"], interface: "wlan1", ap: "wlan1" },
  { mac: "bb:cc:dd:44:55:66", ip: "192.168.1.110", hostname: "DEMO-office-pc", manufacturer: "Dell Inc.", category: "computer", connectionType: "wired", status: "idle", sources: ["dhcp", "arp", "bridge"], interface: "ether2" },
  { mac: "cc:dd:ee:77:88:99", ip: "192.168.1.120", hostname: "DEMO-hik-cam-01", manufacturer: "Hangzhou Hikvision Digital Technology Co., Ltd.", category: "camera", connectionType: "wired", status: "idle", sources: ["dhcp", "arp"], interface: "ether3" },
  { mac: "dd:ee:ff:aa:bb:cc", ip: "192.168.1.130", hostname: "DEMO-tplink-tv", manufacturer: "TP-LINK TECHNOLOGIES CO.,LTD", category: "tv", connectionType: "wireless", status: "online", sources: ["wireless", "dhcp", "bridge"], interface: "wlan2", ap: "wlan2" },
  { mac: "ee:ff:00:11:22:33", ip: "192.168.1.140", hostname: "", manufacturer: "Samsung Electronics Co.,Ltd", category: "unknown", connectionType: "unknown", status: "unknown", sources: ["bridge"], interface: "ether4", vlan: 20 },
  { mac: "ff:11:22:33:44:55", ip: "192.168.1.150", hostname: "DEMO-pppoe-client1", manufacturer: "MikroTik, Ltd.", category: "router", connectionType: "pppoe", status: "online", sources: ["pppoe", "bridge"], interface: "pppoe-client1" },
  { mac: "12:34:56:78:9a:bc", ip: "192.168.1.160", hostname: "DEMO-xiaomi-phone", manufacturer: "Xiaomi Communications Co., Ltd.", category: "phone", connectionType: "hotspot", status: "online", sources: ["hotspot", "wireless", "dhcp"], interface: "wlan1", ap: "wlan1" },
  { mac: "98:76:54:32:10:fe", ip: "192.168.1.170", hostname: "DEMO-printer-hp", manufacturer: "Hewlett Packard", category: "printer", connectionType: "wired", status: "offline", sources: ["dhcp"], interface: "ether2" },
];

async function main() {
  let router = await db.router.findFirst({ where: { isDemo: true } });
  if (!router) {
    router = await db.router.create({
      data: {
        name: "[DEMO] Simulated Router — ليست حقيقية",
        host: "127.0.0.1",
        apiUsername: "demo",
        apiPasswordEnc: encryptSecret("demo-not-real"),
        notes: "بيانات تجريبية لعرض الواجهة فقط — غير مرتبطة بأي سيرفر حقيقي ولا تشارك في المزامنة",
        status: "untested",
        isDemo: true,
        syncEnabled: false,
        identity: "DEMO-SIM",
        version: "7.x-simulated",
        boardName: "DEMO",
      },
    });
  }

  const now = new Date();
  let added = 0;
  for (const d of DEMO_DEVICES) {
    const exists = await db.networkDevice.findUnique({
      where: { routerId_macAddress: { routerId: router.id, macAddress: d.mac } },
    });
    if (exists) continue;
    await db.networkDevice.create({
      data: {
        routerId: router.id,
        macAddress: d.mac,
        ipAddress: d.ip,
        hostname: d.hostname || null,
        customName: d.hostname.startsWith("DEMO") || d.hostname === "" ? d.hostname || null : `DEMO ${d.hostname}`,
        manufacturer: d.manufacturer,
        deviceCategory: d.category,
        connectionType: d.connectionType,
        status: d.status,
        sources: JSON.stringify(d.sources),
        sourceDetails: JSON.stringify(Object.fromEntries(d.sources.map((s) => [s, { state: "demo", ip: d.ip, interface: d.interface }]))),
        interfaceName: d.interface,
        accessPoint: d.ap,
        vlanId: d.vlan,
        comment: "DEMO — بيانات تجريبية وليست من سيرفر حقيقي",
        isNew: true,
        firstSeen: new Date(now.getTime() - Math.random() * 5 * 86400_000),
        lastSeen: now,
        lastActive: d.status === "online" ? now : new Date(now.getTime() - 3600_000),
      },
    });
    await db.dhcpLease.create({
      data: {
        routerId: router.id, address: d.ip, macAddress: d.mac,
        hostname: d.hostname || null, serverName: "defconf", status: d.status === "offline" ? "expired" : "bound",
        dynamic: !d.hostname.startsWith("DEMO-office"),
        comment: "DEMO", seenAt: now, lastSeen: now,
      },
    }).catch(() => {});
    await db.arpEntry.create({
      data: { routerId: router.id, address: d.ip, macAddress: d.mac, interface: d.interface, dynamic: true, complete: d.status !== "offline", seenAt: now },
    }).catch(() => {});
    await db.bridgeHost.create({
      data: { routerId: router.id, macAddress: d.mac, bridge: "bridge", interface: d.interface, vlanId: d.vlan, dynamic: true, seenAt: now },
    }).catch(() => {});
    if (d.ap) {
      await db.wirelessClient.create({
        data: { routerId: router.id, macAddress: d.mac, apiPath: "wireless", interface: d.ap, ssid: "DEMO-Nyt-net", signal: "-58dBm@HT20", txRate: "144.4Mbps-40MHz", rxRate: "130Mbps-20MHz", band: "2.4GHz", uptime: "2h13m", seenAt: now },
      }).catch(() => {});
    }
    added++;
  }
  console.log(`DEMO dataset ready on router "${router.name}" (${router.id}) — ${added} devices added (idempotent).`);
  console.log("These are SIMULATED records clearly labeled DEMO — not real discovery output.");

  // ---- demo network context (interfaces / bridges / routes / traffic) for the topology map ----
  const ctx: { source: string; key: string; data: Record<string, unknown> }[] = [
    { source: "bridges", key: "bridge", data: { name: "bridge", running: "true", mtu: "1500" } },
    { source: "interfaces", key: "ether1", data: { name: "ether1", type: "ether", running: "true", comment: "WAN" } },
    { source: "interfaces", key: "ether2", data: { name: "ether2", type: "ether", running: "true", comment: "LAN" } },
    { source: "interfaces", key: "ether3", data: { name: "ether3", type: "ether", running: "true" } },
    { source: "interfaces", key: "ether4", data: { name: "ether4", type: "ether", running: "true" } },
    { source: "interfaces", key: "wlan1", data: { name: "wlan1", type: "wlan", running: "true", comment: "AP-2.4GHz" } },
    { source: "interfaces", key: "wlan2", data: { name: "wlan2", type: "wlan", running: "true", comment: "AP-5GHz" } },
    { source: "addresses", key: "192.168.1.1/24|bridge", data: { address: "192.168.1.1/24", interface: "bridge" } },
    { source: "routes", key: "0.0.0.0/0|", data: { "dst-address": "0.0.0.0/0", gateway: "192.168.0.1", "gateway-status": "reachable via 192.168.0.1" } },
    { source: "interface_traffic", key: "ether1", data: { rxMbps: 55.4, txMbps: 12.8, ts: Date.now() } },
    { source: "interface_traffic", key: "bridge", data: { rxMbps: 55.4, txMbps: 12.8, ts: Date.now() } },
    { source: "interface_traffic", key: "wlan1", data: { rxMbps: 18.2, txMbps: 4.1, ts: Date.now() } },
    { source: "interface_traffic", key: "wlan2", data: { rxMbps: 8.6, txMbps: 1.2, ts: Date.now() } },
    { source: "interface_traffic", key: "ether2", data: { rxMbps: 9.4, txMbps: 2.2, ts: Date.now() } },
    { source: "dhcp_servers", key: "defconf", data: { name: "defconf", interface: "bridge", disabled: "false" } },
  ];
  for (const c of ctx) {
    await db.networkResource.upsert({
      where: { routerId_source_key: { routerId: router.id, source: c.source, key: c.key } },
      create: { routerId: router.id, source: c.source, key: c.key, data: JSON.stringify(c.data), seenAt: now },
      update: { data: JSON.stringify(c.data), seenAt: now },
    }).catch(() => {});
  }
  console.log("DEMO network context seeded (interfaces/bridges/routes/traffic) for topology rendering.");
}

main().finally(() => db.$disconnect());
