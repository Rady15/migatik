import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { isDeviceManagedRow, autoImportEnabled, AUTO_IMPORT_SETTING } from "@/lib/router-account-guard";

/**
 * Hotspot users created directly on the router (WebFig / CLI / RADIUS) never
 * existed in our DB, so the Users page showed "0 users". Import them on read
 * so the UI always reflects the real router and every row gets a real DB id
 * for edit / suspend / delete actions.
 */

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

function bytesToMb(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round((n / (1024 * 1024)) * 100) / 100 : 0;
}

export interface HotspotImportStats {
  routers: number;
  imported: number;
  updated: number;
  errors: string[];
}

/**
 * Pull every hotspot user from the given routers (or all managed routers) and
 * reconcile into HotspotUser. Org scoping is applied by db.ts proxy because
 * this runs inside the tenant context of the calling route.
 */
export async function importRouterHotspotUsers(routerIds?: string[]): Promise<HotspotImportStats> {
  const stats: HotspotImportStats = { routers: 0, imported: 0, updated: 0, errors: [] };

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

  for (const router of routers) {
    const res = await withRouterRow(router, async (conn) => runCommand(conn, ["/ip/hotspot/user/print"]));
    if (!res.ok || !res.value?.ok) {
      stats.errors.push(`${router.name || router.host}: ${res.error ?? res.value?.error ?? "فشل القراءة"}`);
      continue;
    }
    stats.routers++;

    // Load once and match case-insensitively: RouterOS reports MAC logins in
    // UPPERCASE, while the same user may already exist lowercase in our DB.
    const existingRows = await db.hotspotUser.findMany({ select: { id: true, username: true } });
    const byName = new Map(existingRows.map((u) => [u.username.toLowerCase(), u.id]));

    for (const row of res.value.data) {
      const username = (row.name ?? "").trim();
      if (!username) continue;
      // Never import RouterOS-managed entries: `default` is a built-in template
      // (e.g. default-trial) and `dynamic` users are auto-created by logins.
      // Both are read-only on the device, so importing them creates rows the
      // user can never delete (RouterOS rejects the remove).
      if (isDeviceManagedRow(row)) continue;

      const disabled = row.disabled === "true";
      const dataUsedMb = bytesToMb(row["bytes-in"]) + bytesToMb(row["bytes-out"]);
      const uptimeSec = parseUptime(row.uptime);
      const profile = (row.profile ?? "default").trim() || "default";

      const existingId = byName.get(username.toLowerCase());
      const baseData = {
        username,
        profile,
        status: disabled ? "suspended" : "active",
        dataUsedMb,
        uptimeSec,
        routerId: router.id,
        routerSynced: true,
      };
      if (existingId) {
        await db.hotspotUser.update({ where: { id: existingId }, data: baseData });
        stats.updated++;
      } else {
        const created = await db.hotspotUser.create({
          data: { ...baseData, password: "" }, // RouterOS API does not expose plaintext passwords.
        });
        byName.set(username.toLowerCase(), created.id);
        stats.imported++;
      }
    }
  }

  return stats;
}
