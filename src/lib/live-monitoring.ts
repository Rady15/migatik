import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";

/**
 * Live monitoring data comes straight from the router — the old DB tables
 * (hotspotSession / routerMetric) were never populated with real sessions and
 * held inflated traffic samples, so charts and the sessions list were empty
 * or wildly wrong.
 */

export interface LiveSession {
  id: string;
  username: string;
  ip: string | null;
  mac: string | null;
  routerId: string;
  routerName: string;
  startedAt: string;
  durationSec: number;
  uploadMb: number;
  downloadMb: number;
  speed: string;
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

function ifaceMbps(value?: string): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n / 1e6 : 0;
}

export interface LiveMonitoring {
  sessions: LiveSession[];
  traffic: { routerId: string; routerName: string; downloadMbps: number; uploadMbps: number; activeUsers: number }[];
  errors: string[];
}

export async function readLiveMonitoring(routerIds?: string[]): Promise<LiveMonitoring> {
  const out: LiveMonitoring = { sessions: [], traffic: [], errors: [] };
  const routers = await db.router.findMany({
    where: {
      isDemo: false,
      ...(routerIds && routerIds.length > 0 && !routerIds.includes("all") ? { id: { in: routerIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  // Profile → download speed, for the "السرعة" column.
  const profiles = await db.package.findMany({ select: { profile: true, downloadMbps: true } });
  const speedByProfile = new Map(profiles.map((p) => [p.profile.toLowerCase(), p.downloadMbps]));

  for (const router of routers) {
    const res = await withRouterRow(router, async (conn) => {
      const active = await runCommand(conn, ["/ip/hotspot/active/print"]);
      if (!active.ok) return { active, traffic: null };

      // Per-interface real bits-per-second.
      const ifaces = await runCommand(conn, ["/interface/print"]);
      const names = (ifaces.ok ? ifaces.data : [])
        .filter((r) => !r.type || r.type === "ether")
        .map((r) => r.name)
        .filter((n): n is string => !!n && n !== "lo");
      let rx = 0;
      let tx = 0;
      for (const name of names) {
        const m = await runCommand(conn, ["/interface/monitor-traffic", `=interface=${name}`, "=once="]);
        if (!m.ok) continue;
        for (const row of m.data) {
          rx += ifaceMbps(row["rx-bits-per-second"]);
          tx += ifaceMbps(row["tx-bits-per-second"]);
        }
      }

      // Fallback: a RECENT real sample from discovery (never cumulative bytes).
      // Only trust samples written in the last 2 minutes; old rows were produced
      // by the buggy bytes-as-bps collector and would re-inflate the chart.
      if (rx === 0 && tx === 0) {
        const cached = await db.networkResource.findMany({
          where: { routerId: router.id, source: "interface_traffic", seenAt: { gte: new Date(Date.now() - 120_000) } },
        });
        for (const c of cached) {
          let d: { rxMbps?: number; txMbps?: number } = {};
          try { d = JSON.parse(c.data || "{}"); } catch { /* ignore malformed cache */ }
          rx += Number(d.rxMbps ?? 0);
          tx += Number(d.txMbps ?? 0);
        }
      }
      return { active, traffic: { rx, tx } };
    });

    if (!res.ok || !res.value) {
      out.errors.push(`${router.name || router.host}: ${res.error ?? "فشل القراءة"}`);
      continue;
    }

    const active = res.value.active;
    if (!active.ok) {
      out.errors.push(`${router.name || router.host}: ${active.error ?? "فشل قراءة الجلسات"}`);
    } else {
      // Also persist real active sessions so other views (dashboard KPIs,
      // reports) stop reporting zero. Replace this router's active rows.
      await db.hotspotSession.deleteMany({ where: { routerId: router.id, status: "active" } }).catch(() => {});
      for (const row of active.data) {
        const username = row.user ?? row["mac-address"] ?? "";
        if (!username) continue;
        const durationSec = parseUptime(row.uptime);
        const profile = (await db.hotspotUser.findFirst({ where: { username } }))?.profile ?? "default";
        const speedMbps = speedByProfile.get(profile.toLowerCase()) ?? 0;
        const bytesIn = Number(row["bytes-in"] ?? 0);
        const bytesOut = Number(row["bytes-out"] ?? 0);

        await db.hotspotSession.create({
          data: {
            username,
            routerId: router.id,
            ip: row.address ?? null,
            mac: row["mac-address"] ?? null,
            startedAt: new Date(Date.now() - durationSec * 1000),
            durationSec,
            uploadMb: Math.round((bytesIn / (1024 * 1024)) * 100) / 100,
            downloadMb: Math.round((bytesOut / (1024 * 1024)) * 100) / 100,
            status: "active",
          },
        }).catch(() => {});

        out.sessions.push({
          id: row[".id"] ?? `${router.id}:${username}`,
          username,
          ip: row.address ?? null,
          mac: row["mac-address"] ?? null,
          routerId: router.id,
          routerName: router.name,
          startedAt: new Date(Date.now() - durationSec * 1000).toISOString(),
          durationSec,
          uploadMb: Math.round((bytesIn / (1024 * 1024)) * 100) / 100,
          downloadMb: Math.round((bytesOut / (1024 * 1024)) * 100) / 100,
          speed: speedMbps > 0 ? `${speedMbps} Mbps` : "—",
        });
      }
    }

    if (res.value.traffic) {
      out.traffic.push({
        routerId: router.id,
        routerName: router.name,
        downloadMbps: Math.round(res.value.traffic.rx * 100) / 100,
        uploadMbps: Math.round(res.value.traffic.tx * 100) / 100,
        activeUsers: out.sessions.filter((s) => s.routerId === router.id).length,
      });
    }
  }

  return out;
}
