import { runCommand, type RosConnection } from "@/lib/routeros";

/**
 * RouterOS section manager (v3) — read/write operations for the ISP modules.
 *
 * SAFETY MODEL (honest, not absolute):
 * - command paths are whitelisted per section (no arbitrary commands);
 * - destructive ops (remove/set) need confirm=true after the UI shows a preview;
 * - firewall rules that could lock out the admin session (chain=input) require
 *   an explicit allowInputRule acknowledgement AND are tagged "mtcm-managed"
 *   so they can be listed/removed by the recovery endpoint;
 * - a recovery endpoint removes ALL mtcm-managed rules in one confirmed call;
 * - we do NOT claim lockouts are impossible — we make them unlikely and reversible.
 */

export interface SectionDef {
  id: string;
  titleAr: string;
  titleEn: string;
  printPath: string;
  addPath?: string;
  setPath?: string;
  removePath?: string;
  /** fields allowed on add/set — anything else is rejected (command validation) */
  fields: string[];
  /** preferred live-table columns (the real row values are still returned untouched) */
  columns?: string[];
  /** fallback menu paths for RouterOS versions where the legacy path was removed (e.g. caps-man → wifi) */
  alt?: { printPath?: string; addPath?: string; setPath?: string; removePath?: string };
  /** RouterOS v7-only sections */
  v7Only?: boolean;
  /** RouterOS v6-only sections */
  v6Only?: boolean;
  minConfirm?: "confirm" | "input_ack";
}

export const SECTIONS: Record<string, SectionDef> = {
  dhcp_servers:      { id: "dhcp_servers", titleAr: "سيرفرات DHCP", titleEn: "DHCP Servers", printPath: "/ip/dhcp-server/print", addPath: "/ip/dhcp-server/add", setPath: "/ip/dhcp-server/set", removePath: "/ip/dhcp-server/remove", fields: ["name", "interface", "address-pool", "lease-time", "disabled", "comment"], columns: ["name", "interface", "address-pool", "lease-time", "disabled", "comment"] },
  dhcp_networks:     { id: "dhcp_networks", titleAr: "شبكات DHCP", titleEn: "DHCP Networks", printPath: "/ip/dhcp-server/network/print", addPath: "/ip/dhcp-server/network/add", setPath: "/ip/dhcp-server/network/set", removePath: "/ip/dhcp-server/network/remove", fields: ["address", "gateway", "netmask", "dns-server", "domain", "comment"], columns: ["address", "gateway", "netmask", "dns-server", "domain", "comment"] },
  ip_addresses:      { id: "ip_addresses", titleAr: "عناوين IP", titleEn: "IP Addresses", printPath: "/ip/address/print", addPath: "/ip/address/add", setPath: "/ip/address/set", removePath: "/ip/address/remove", fields: ["address", "interface", "comment", "disabled"], columns: ["address", "interface", "network", "actual-interface", "disabled", "comment"] },
  ip_pools:          { id: "ip_pools", titleAr: "مجموعات IP", titleEn: "IP Pools", printPath: "/ip/pool/print", addPath: "/ip/pool/add", setPath: "/ip/pool/set", removePath: "/ip/pool/remove", fields: ["name", "ranges", "comment"], columns: ["name", "ranges", "total", "used", "available"] },
  vlans:             { id: "vlans", titleAr: "واجهات VLAN", titleEn: "VLAN Interfaces", printPath: "/interface/vlan/print", addPath: "/interface/vlan/add", setPath: "/interface/vlan/set", removePath: "/interface/vlan/remove", fields: ["name", "vlan-id", "interface", "disabled", "comment"], columns: ["name", "interface", "vlan-id", "disabled", "comment"] },
  bridges:           { id: "bridges", titleAr: "الجسور", titleEn: "Bridges", printPath: "/interface/bridge/print", addPath: "/interface/bridge/add", setPath: "/interface/bridge/set", removePath: "/interface/bridge/remove", fields: ["name", "vlan-filtering", "disabled", "comment"], columns: ["name", "vlan-filtering", "disabled", "comment"] },
  bridge_ports:      { id: "bridge_ports", titleAr: "منافذ الجسور", titleEn: "Bridge Ports", printPath: "/interface/bridge/port/print", addPath: "/interface/bridge/port/add", setPath: "/interface/bridge/port/set", removePath: "/interface/bridge/port/remove", fields: ["bridge", "interface", "pvid", "disabled", "comment"], columns: ["bridge", "interface", "pvid", "disabled", "comment"] },
  wireless:          { id: "wireless", titleAr: "اللاسلكي (legacy)", titleEn: "Wireless (legacy)", printPath: "/interface/wireless/print", addPath: "/interface/wireless/add", setPath: "/interface/wireless/set", removePath: "/interface/wireless/remove", fields: ["name", "ssid", "mode", "band", "frequency", "disabled", "comment"], columns: ["name", "ssid", "mode", "band", "frequency", "disabled", "comment"] },
  wifi:              { id: "wifi", titleAr: "WiFi (v7)", titleEn: "WiFi (v7)", printPath: "/interface/wifi/print", addPath: "/interface/wifi/add", setPath: "/interface/wifi/set", removePath: "/interface/wifi/remove", fields: ["name", "ssid", "disabled", "comment"], columns: ["name", "ssid", "disabled", "comment"], v7Only: true },
  capsman:           { id: "capsman", titleAr: "CAPsMAN", titleEn: "CAPsMAN", printPath: "/caps-man/manager/print", setPath: "/caps-man/manager/set", fields: ["enabled", "certificate", "require-peer-certificate"], columns: ["enabled", "certificate", "require-peer-certificate"], alt: { printPath: "/interface/wifi/capsman/print", setPath: "/interface/wifi/capsman/set" } },
  capsman_provisions:{ id: "capsman_provisions", titleAr: "قواعد CAPsMAN", titleEn: "CAPsMAN Provisioning", printPath: "/caps-man/provisioning/print", addPath: "/caps-man/provisioning/add", setPath: "/caps-man/provisioning/set", removePath: "/caps-man/provisioning/remove", fields: ["action", "master-configuration", "comment"], columns: ["action", "master-configuration", "comment"], alt: { printPath: "/interface/wifi/provisioning/print", addPath: "/interface/wifi/provisioning/add", setPath: "/interface/wifi/provisioning/set", removePath: "/interface/wifi/provisioning/remove" } },
  hotspot_servers:   { id: "hotspot_servers", titleAr: "سيرفرات Hotspot", titleEn: "Hotspot Servers", printPath: "/ip/hotspot/print", addPath: "/ip/hotspot/add", setPath: "/ip/hotspot/set", removePath: "/ip/hotspot/remove", fields: ["name", "interface", "address-pool", "disabled", "comment"], columns: ["name", "interface", "profile", "address-pool", "disabled"] },
  hotspot_users:     { id: "hotspot_users", titleAr: "مستخدمو Hotspot", titleEn: "Hotspot Users", printPath: "/ip/hotspot/user/print", addPath: "/ip/hotspot/user/add", setPath: "/ip/hotspot/user/set", removePath: "/ip/hotspot/user/remove", fields: ["name", "password", "profile", "disabled", "comment", "limit-uptime", "limit-bytes-total"], columns: ["name", "server", "profile", "uptime", "bytes-in", "bytes-out", "disabled", "comment"] },
  hotspot_profiles:  { id: "hotspot_profiles", titleAr: "بروفايلات Hotspot", titleEn: "Hotspot Profiles", printPath: "/ip/hotspot/user/profile/print", addPath: "/ip/hotspot/user/profile/add", setPath: "/ip/hotspot/user/profile/set", removePath: "/ip/hotspot/user/profile/remove", fields: ["name", "rate-limit", "shared-users", "session-timeout", "login-by", "comment"], columns: ["name", "rate-limit", "shared-users", "session-timeout", "login-by", "idle-timeout", "comment"] },
  hotspot_active:    { id: "hotspot_active", titleAr: "Hotspot Active (الآن)", titleEn: "Hotspot Active (live)", printPath: "/ip/hotspot/active/print", fields: [], columns: ["user", "address", "mac-address", "server", "login-by", "uptime", "bytes-in", "bytes-out", "comment"] },
  hotspot_hosts:     { id: "hotspot_hosts", titleAr: "Hotspot Hosts (مستضاف الآن)", titleEn: "Hotspot Hosts (live)", printPath: "/ip/hotspot/host/print", fields: [], columns: ["mac-address", "address", "to-address", "server", "uptime", "bytes-in", "bytes-out", "authorized", "bypassed"] },
  hotspot_bindings:  { id: "hotspot_bindings", titleAr: "Hotspot Bindings (الربط)", titleEn: "Hotspot Bindings", printPath: "/ip/hotspot/ip-binding/print", fields: [], columns: ["mac-address", "address", "to-address", "server", "type", "disabled", "comment"] },
  ppp_secrets:       { id: "ppp_secrets", titleAr: "حسابات PPPoE", titleEn: "PPP Secrets", printPath: "/ppp/secret/print", addPath: "/ppp/secret/add", setPath: "/ppp/secret/set", removePath: "/ppp/secret/remove", fields: ["name", "password", "service", "profile", "disabled", "comment"], columns: ["name", "service", "profile", "disabled", "comment"] },
  ppp_profiles:      { id: "ppp_profiles", titleAr: "بروفايلات PPPoE", titleEn: "PPP Profiles", printPath: "/ppp/profile/print", addPath: "/ppp/profile/add", setPath: "/ppp/profile/set", removePath: "/ppp/profile/remove", fields: ["name", "local-address", "remote-address", "rate-limit", "comment"], columns: ["name", "local-address", "remote-address", "rate-limit", "comment"] },
  simple_queues:     { id: "simple_queues", titleAr: "الطوابير البسيطة", titleEn: "Simple Queues", printPath: "/queue/simple/print", addPath: "/queue/simple/add", setPath: "/queue/simple/set", removePath: "/queue/simple/remove", fields: ["name", "target", "max-limit", "disabled", "comment"], columns: ["name", "target", "max-limit", "disabled", "comment"] },
  queue_trees:       { id: "queue_trees", titleAr: "أشجار الطوابير", titleEn: "Queue Trees", printPath: "/queue/tree/print", addPath: "/queue/tree/add", setPath: "/queue/tree/set", removePath: "/queue/tree/remove", fields: ["name", "parent", "packet-mark", "max-limit", "priority", "disabled"], columns: ["name", "parent", "packet-mark", "max-limit", "priority", "disabled"] },
  firewall_filter:   { id: "firewall_filter", titleAr: "جدار الحماية (Filter)", titleEn: "Firewall Filter", printPath: "/ip/firewall/filter/print", addPath: "/ip/firewall/filter/add", setPath: "/ip/firewall/filter/set", removePath: "/ip/firewall/filter/remove", fields: ["chain", "action", "src-address", "dst-address", "protocol", "dst-port", "in-interface", "out-interface", "src-address-list", "dst-address-list", "comment", "disabled", "place-before"], columns: ["chain", "action", "protocol", "src-address", "dst-address", "dst-port", "in-interface", "comment", "disabled"], minConfirm: "input_ack" },
  firewall_nat:      { id: "firewall_nat", titleAr: "NAT", titleEn: "Firewall NAT", printPath: "/ip/firewall/nat/print", addPath: "/ip/firewall/nat/add", setPath: "/ip/firewall/nat/set", removePath: "/ip/firewall/nat/remove", fields: ["chain", "action", "out-interface", "in-interface", "to-addresses", "src-address", "dst-address", "src-port", "dst-port", "protocol", "comment", "disabled"], columns: ["chain", "action", "protocol", "out-interface", "to-addresses", "dst-address", "dst-port", "comment", "disabled"] },
  dns:               { id: "dns", titleAr: "إعدادات DNS", titleEn: "DNS Settings", printPath: "/ip/dns/print", setPath: "/ip/dns/set", fields: ["servers", "allow-remote-requests", "dynamic-servers"], columns: ["servers", "allow-remote-requests", "dynamic-servers"] },
  routes:            { id: "routes", titleAr: "جدول التوجيه", titleEn: "Routes", printPath: "/ip/route/print", addPath: "/ip/route/add", setPath: "/ip/route/set", removePath: "/ip/route/remove", fields: ["dst-address", "gateway", "distance", "comment", "disabled"], columns: ["dst-address", "gateway", "distance", "active", "dynamic", "comment"] },
  interfaces:        { id: "interfaces", titleAr: "الواجهات", titleEn: "Interfaces", printPath: "/interface/print", setPath: "/interface/set", removePath: "/interface/remove", fields: ["name", "disabled", "comment"], columns: ["name", "type", "mtu", "mac-address", "running", "rx-byte", "tx-byte", "disabled"] },
  services:          { id: "services", titleAr: "خدمات الإدارة", titleEn: "IP Services", printPath: "/ip/service/print", setPath: "/ip/service/set", fields: ["address", "disabled", "port"], columns: ["name", "port", "proto", "available-from", "disabled"] },
};

export interface RosSectionResult {
  ok: boolean;
  error?: string;
  rows: Record<string, string>[];
  section: SectionDef;
  unsupported?: boolean;
  /** the menu path that actually answered (legacy path may be gone on RouterOS 7) */
  printPathUsed?: string;
}

export function isUnsupportedError(msg?: string): boolean {
  return /no such item|no such command|no such directory|unknown parameter|bad command|do not exist|invalid internal item/i.test(msg ?? "");
}

/** Narrower: the menu path itself does not exist on this RouterOS version (safe to retry another path). */
export function isMissingMenuError(msg?: string): boolean {
  return /no such command|no such directory|no such item|do not exist/i.test(msg ?? "");
}

/** All menu paths that may serve this section on the connected RouterOS version. */
export function printPaths(section: SectionDef): string[] {
  return [section.printPath, section.alt?.printPath].filter(Boolean) as string[];
}

/** Live read of a section (never cached — shows the router's current truth). */
export async function readSection(conn: RosConnection, sectionId: string, timeoutMs = 20000): Promise<RosSectionResult> {
  const section = SECTIONS[sectionId];
  if (!section) return { ok: false, error: `قسم غير معروف: ${sectionId}`, rows: [], section: { id: sectionId, titleAr: "", titleEn: "", printPath: "", fields: [] } };
  let lastError: string | undefined;
  for (const path of printPaths(section)) {
    const res = await runCommand(conn, [path], timeoutMs);
    if (res.ok) return { ok: true, rows: res.data, section, printPathUsed: path };
    lastError = res.error;
    // Stop on connection/timeout/permission errors — only missing menus deserve a fallback try.
    if (!isMissingMenuError(res.error)) break;
  }
  return { ok: false, error: lastError, rows: [], section, unsupported: isUnsupportedError(lastError), printPathUsed: printPaths(section)[0] };
}

const FORBIDDEN = /(\/quit|\/system\/reboot|\/system\/shutdown|\/system\/format|\/file\/remove|\/system\/reset-configuration|\/system\/routerboard)/i;

/** Validate a command path against the whitelist — command validation gate. */
export function validateCommand(path: string, section: SectionDef): string | null {
  if (FORBIDDEN.test(path)) return "أمر ممنوع تماماً (إعادة تشغيل/تهيئة/حذف ملفات)";
  const allowed = new Set(
    [
      section.printPath, section.addPath, section.setPath, section.removePath,
      section.alt?.printPath, section.alt?.addPath, section.alt?.setPath, section.alt?.removePath,
    ].filter(Boolean) as string[],
  );
  if (!allowed.has(path)) return `مسار الأمر غير مسموح لهذا القسم: ${path}`;
  return null;
}

/** Primary write path + v7 fallback path for the requested operation. */
export function writePaths(section: SectionDef, op: "add" | "set" | "remove"): { primary: string; fallback?: string } {
  const key = op === "add" ? "addPath" : op === "set" ? "setPath" : "removePath";
  return { primary: section[key] as string, fallback: section.alt?.[key] };
}

/** Build add/set words from a body object, restricted to section fields. */
export function buildWords(section: SectionDef, data: Record<string, unknown>): { words: string[]; rejected: string[] } {
  const words: string[] = [];
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!section.fields.includes(k)) { rejected.push(k); continue; }
    const s = String(v);
    // value sanity: no sentence-terminating sequences that could inject extra words
    if (/[\r\n]/.test(s)) { rejected.push(k); continue; }
    words.push(`=${k}=${s}`);
  }
  return { words, rejected };
}

/** Post-write safety check: verify the admin API session is still alive. */
export async function sanityCheck(conn: RosConnection): Promise<{ ok: boolean; error?: string }> {
  const res = await runCommand(conn, ["/system/identity/print"], 6000);
  return res.ok ? { ok: true } : { ok: false, error: "فقد الاتصال بالسيرفر بعد الكتابة — راجع القواعد فوراً عبر Winbox/الكونسول المحلي" };
}
