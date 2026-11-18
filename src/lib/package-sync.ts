import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";

/**
 * Import RouterOS hotspot user profiles as Packages. The router is the source
 * of truth for the profile list and its rate limits; price / duration are
 * billing-only fields that stay at the app defaults (RouterOS has none).
 */

const IMPORT_TAG = "[router-import]";

/** "1M/1M" → { down: 1, up: 1 }; "512k/1M" → { down: 0.5, up: 1 }. */
function parseRateLimit(value?: string): { down: number; up: number } {
  if (!value) return { down: 0, up: 0 };
  const first = value.trim().split(/\s+/)[0];
  const [d = "0", u = "0"] = first.split("/");
  const toMb = (s: string): number => {
    const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)/i.exec(s.trim());
    if (!m) return 0;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "k") return Math.round((n / 1024) * 1000) / 1000;
    if (unit === "g") return n * 1024;
    return n;
  };
  return { down: toMb(d), up: toMb(u) };
}

export interface PackageImportStats {
  routers: number;
  imported: number;
  updated: number;
  errors: string[];
}

export async function importRouterProfiles(routerIds?: string[]): Promise<PackageImportStats> {
  const stats: PackageImportStats = { routers: 0, imported: 0, updated: 0, errors: [] };

  const routers = await db.router.findMany({
    where: {
      isDemo: false,
      ...(routerIds && routerIds.length > 0 && !routerIds.includes("all") ? { id: { in: routerIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  for (const router of routers) {
    const res = await withRouterRow(router, async (conn) => runCommand(conn, ["/ip/hotspot/user/profile/print"]));
    if (!res.ok || !res.value?.ok) {
      stats.errors.push(`${router.name || router.host}: ${res.error ?? res.value?.error ?? "فشل القراءة"}`);
      continue;
    }
    stats.routers++;

    const existing = await db.package.findMany({
      where: { OR: [{ routerId: router.id }, { routerId: null }] },
      select: { id: true, name: true, profile: true, description: true },
    });
    const byProfile = new Map(existing.map((p) => [p.profile.toLowerCase(), p]));

    for (const row of res.value.data) {
      const name = (row.name ?? "").trim();
      if (!name) continue;

      const { down, up } = parseRateLimit(row["rate-limit"]);
      const description = row.default === "true"
        ? `${IMPORT_TAG} الباقة الافتراضية على الراوتر`
        : `${IMPORT_TAG} بروفايل الراوتر — ${row["rate-limit"] || "بدون حد"}`;

      const found = byProfile.get(name.toLowerCase());
      let packageId: string;
      if (found) {
        await db.package.update({
          where: { id: found.id },
          data: {
            downloadMbps: down,
            uploadMbps: up,
            routerId: router.id,
            ...(found.description?.startsWith(IMPORT_TAG) ? { description } : {}),
          },
        });
        packageId = found.id;
        stats.updated++;
      } else {
        const created = await db.package.create({
          data: {
            name,
            profile: name,
            description,
            downloadMbps: down,
            uploadMbps: up,
            dataLimitMb: null,
            durationHours: 720,
            price: 0,
            routerId: router.id,
            active: true,
          },
        });
        packageId = created.id;
        byProfile.set(name.toLowerCase(), { id: created.id, name, profile: name, description });
        stats.imported++;
      }

      // Link imported hotspot users on this router to their real profile.
      // SQLite has no `mode: insensitive`, so match the ids in JS.
      const matchingUsers = await db.hotspotUser.findMany({
        where: { routerId: router.id },
        select: { id: true, profile: true },
      });
      const userIds = matchingUsers.filter((u) => (u.profile ?? "").toLowerCase() === name.toLowerCase()).map((u) => u.id);
      if (userIds.length) {
        await db.hotspotUser.updateMany({ where: { id: { in: userIds } }, data: { packageId } });
      }
    }
  }

  return stats;
}
