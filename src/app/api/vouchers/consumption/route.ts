import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { syncVoucherUsage } from "@/lib/voucher-lifecycle";

/**
 * Full consumption view for prepaid cards: every used card with its sale /
 * activation / expiry times plus the REAL usage read from RouterOS
 * (uptime, bytes in/out, currently connected). No fabricated numbers.
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

interface Usage {
  uptime?: string;
  uptimeSec: number;
  bytesIn: number;
  bytesOut: number;
  active: boolean;
  disabled: boolean;
  profile?: string;
}

export const GET = withOrg(async (req: NextRequest) => {
  try {
    // Make sure a card used seconds ago is already reflected before reporting.
    await syncVoucherUsage().catch(() => {});

    const requested = req.nextUrl.searchParams.get("routerId");
    const where: Record<string, unknown> = {
      status: { in: ["sold", "activated", "expired"] },
    };
    if (requested && requested !== "all") where.routerId = requested;

    const cards = await db.voucher.findMany({
      where,
      orderBy: [{ activatedAt: "desc" }, { soldAt: "desc" }, { createdAt: "desc" }],
      take: 500,
      select: {
        id: true, username: true, serial: true, status: true, price: true, currency: true,
        soldAt: true, activatedAt: true, expiresAt: true, routerId: true,
        router: { select: { name: true } },
        package: { select: { name: true } },
      },
    });

    const routers = await db.router.findMany({
      where: { isDemo: false, ...(requested && requested !== "all" ? { id: requested } : {}) },
      select: {
        id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true,
        apiUsername: true, apiPasswordEnc: true, connectionMethod: true, agentId: true,
      },
    });

    const usageByRouter = new Map<string, Map<string, Usage>>();
    const errors: string[] = [];

    for (const router of routers) {
      const res = await withRouterRow(router, async (conn) => {
        const [active, users] = await Promise.all([
          runCommand(conn, ["/ip/hotspot/active/print"]),
          runCommand(conn, ["/ip/hotspot/user/print"]),
        ]);
        const map = new Map<string, Usage>();
        const touch = (name: string): Usage => {
          const key = name.trim().toLowerCase();
          let u = map.get(key);
          if (!u) {
            u = { uptimeSec: 0, bytesIn: 0, bytesOut: 0, active: false, disabled: false };
            map.set(key, u);
          }
          return u;
        };

        for (const row of (active.ok ? active.data : []) as Record<string, unknown>[]) {
          const name = String(row.user ?? "").trim();
          if (!name) continue;
          const u = touch(name);
          u.active = true;
          u.uptime = String(row.uptime ?? u.uptime ?? "");
          u.uptimeSec = Math.max(u.uptimeSec, parseUptime(String(row.uptime ?? "")));
          u.bytesIn += Number(row["bytes-in"] ?? 0);
          u.bytesOut += Number(row["bytes-out"] ?? 0);
        }
        for (const row of (users.ok ? users.data : []) as Record<string, unknown>[]) {
          const name = String(row.name ?? "").trim();
          if (!name) continue;
          const uptimeSec = parseUptime(String(row.uptime ?? ""));
          const bytesIn = Number(row["bytes-in"] ?? 0);
          const bytesOut = Number(row["bytes-out"] ?? 0);
          if (!uptimeSec && !bytesIn && !bytesOut) continue;
          const u = touch(name);
          u.uptime = String(row.uptime ?? u.uptime ?? "");
          u.uptimeSec = Math.max(u.uptimeSec, uptimeSec);
          u.bytesIn = Math.max(u.bytesIn, bytesIn);
          u.bytesOut = Math.max(u.bytesOut, bytesOut);
          u.disabled = String(row.disabled ?? "false").toLowerCase() === "true";
          u.profile = row.profile ? String(row.profile) : undefined;
        }
        return { map, activeOk: active.ok, usersOk: users.ok, activeErr: active.error, usersErr: users.error };
      });

      if (!res.ok || !res.value) {
        errors.push(`${router.name}: ${res.error ?? "تعذر الاتصال"}`);
        continue;
      }
      usageByRouter.set(router.id, res.value.map);
      if (!res.value.activeOk) errors.push(`${router.name}: ${res.value.activeErr ?? "active print failed"}`);
      if (!res.value.usersOk) errors.push(`${router.name}: ${res.value.usersErr ?? "user print failed"}`);
    }

    const items = cards.map((v) => {
      const usage = (v.routerId ? usageByRouter.get(v.routerId)?.get(v.username.toLowerCase()) : undefined) ?? null;
      return {
        ...v,
        usage,
      };
    });

    return NextResponse.json({
      items,
      totals: {
        used: cards.length,
        revenue: cards.reduce((sum, v) => sum + (Number(v.price) || 0), 0),
        connected: items.filter((v) => v.usage?.active).length,
      },
      errors,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return serverError(e);
  }
});
