import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { recordEvent } from "@/lib/subscribers";
import {
  isDeviceManagedRow,
  autoImportEnabled,
  AUTO_IMPORT_SETTING,
} from "@/lib/router-account-guard";

/**
 * The "unified subscriber file" must reflect accounts that actually exist on
 * the router. Users created in WebFig/CLI never reached the Subscriber table,
 * leaving the page empty or full of hand-typed test rows. Import them here.
 */

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const IMPORT_NOTE = "[router-import]";

function displayName(username: string, hostnameByMac: Map<string, string>): string {
  if (MAC_RE.test(username)) {
    const host = hostnameByMac.get(username.toLowerCase());
    if (host) return host;
  }
  return username;
}

function nextCode(existing: Set<string>): string {
  const year = new Date().getFullYear();
  let n = existing.size + 1;
  let code = `SUB-${year}-${String(n).padStart(5, "0")}`;
  while (existing.has(code)) {
    n++;
    code = `SUB-${year}-${String(n).padStart(5, "0")}`;
  }
  existing.add(code);
  return code;
}

export interface SubscriberImportStats {
  routers: number;
  imported: number;
  updated: number;
  errors: string[];
}

export async function importRouterSubscribers(routerIds?: string[]): Promise<SubscriberImportStats> {
  const stats: SubscriberImportStats = { routers: 0, imported: 0, updated: 0, errors: [] };

  // Operator can disable automatic account import entirely from Settings.
  const setting = await db.setting.findUnique({ where: { key: AUTO_IMPORT_SETTING } }).catch(() => null);
  if (!autoImportEnabled(setting?.value)) return stats;

  const routers = await db.router.findMany({
    where: {
      isDemo: false,
      ...(routerIds && routerIds.length > 0 && !routerIds.includes("all") ? { id: { in: routerIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  // Device hostnames give MAC-based hotspot users a human-readable name.
  const devices = await db.networkDevice.findMany({ select: { macAddress: true, hostname: true, customName: true } });
  const hostnameByMac = new Map<string, string>();
  for (const d of devices) {
    const name = d.customName || d.hostname;
    if (d.macAddress && name) hostnameByMac.set(d.macAddress.toLowerCase(), name);
  }

  const existing = await db.subscriber.findMany({ select: { id: true, code: true, username: true, routerId: true } });
  const byUsername = new Map(existing.map((s) => [`${s.routerId ?? ""}:${(s.username ?? "").toLowerCase()}`, s]));
  const codes = new Set(existing.map((s) => s.code));

  for (const router of routers) {
    const res = await withRouterRow(router, async (conn) => runCommand(conn, ["/ip/hotspot/user/print"]));
    if (!res.ok || !res.value?.ok) {
      stats.errors.push(`${router.name || router.host}: ${res.error ?? res.value?.error ?? "فشل القراءة"}`);
      continue;
    }
    stats.routers++;

    for (const row of res.value.data) {
      const username = (row.name ?? "").trim();
      if (!username) continue;
      // Skip RouterOS built-in templates (default-trial) and dynamic MAC logins.
      if (isDeviceManagedRow(row)) continue;

      const key = `${router.id}:${username.toLowerCase()}`;
      const found = byUsername.get(key);
      const disabled = row.disabled === "true";
      const mac = MAC_RE.test(username) ? username.toUpperCase() : null;

      if (found) {
        await db.subscriber.update({
          where: { id: found.id },
          data: {
            status: disabled ? "suspended" : "active",
            routerId: router.id,
            ...(mac ? { macAddresses: JSON.stringify([mac]) } : {}),
          },
        });
        stats.updated++;
      } else {
        const created = await db.subscriber.create({
          data: {
            code: nextCode(codes),
            name: displayName(username, hostnameByMac),
            username,
            routerId: router.id,
            accountType: "hotspot",
            status: disabled ? "suspended" : "active",
            macAddresses: mac ? JSON.stringify([mac]) : null,
            notes: `${IMPORT_NOTE} مستورد من الراوتر`,
          },
        });
        byUsername.set(key, { id: created.id, code: created.code, username, routerId: router.id });
        await recordEvent(created.id, "registered", "مستورد من حسابات الراوتر الحقيقية", "system");
        stats.imported++;
      }
    }
  }

  return stats;
}
