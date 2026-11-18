import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { hashEnrollToken, isValidEnrollToken, makeRateLimiter, plainText } from "@/lib/router-enroll";

/**
 * PUBLIC — heartbeat sent by the router every 5 minutes.
 *
 *   GET /api/onboard/heartbeat/<token>
 *
 * It proves the router is alive and keeps `lastOnlineAt` fresh. If the router is
 * not yet marked online, a quick API login is attempted (first connect after a
 * reboot / after the API service became reachable again) — the heartbeat itself
 * never fabricates an "online" state.
 */
export const dynamic = "force-dynamic";
const allow = makeRateLimiter(120);

function pathToken(req: NextRequest): string {
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (!allow(ip)) return plainText("ERROR too-many-requests", 429);

  const token = pathToken(req);
  if (!isValidEnrollToken(token)) return plainText("ERROR invalid-token", 404);

  const enrollment = await db.routerEnrollment.findUnique({
    where: { tokenHash: hashEnrollToken(token) },
    select: { id: true, status: true, routerId: true },
  });
  if (!enrollment || enrollment.status !== "installed" || !enrollment.routerId) {
    return plainText("PENDING not-enrolled-yet");
  }

  const router = await db.router.findUnique({ where: { id: enrollment.routerId } });
  if (!router) return plainText("ERROR router-missing", 404);

  await db.router.update({ where: { id: router.id }, data: { lastOnlineAt: new Date() } }).catch(() => {});

  if (router.status !== "online") {
    const res = await withRouterRow(router, (conn) => runCommand(conn, ["/system/resource/print"], 6000), {
      connectTimeoutMs: 6000,
      commandTimeoutMs: 6000,
    });
    if (res.ok) {
      const r = res.value?.data?.[0] ?? {};
      const mb = (v?: string) => (v ? Math.floor(Number(v) / 1024 / 1024) : null);
      await db.router.update({
        where: { id: router.id },
        data: {
          status: "online",
          statusMessage: null,
          lastOnlineAt: new Date(),
          lastCheckedAt: new Date(),
          version: r["version"] ?? router.version,
          boardName: r["board-name"] ?? router.boardName,
          uptime: r["uptime"] ?? router.uptime,
          cpuLoad: r["cpu-load"] ? Number(r["cpu-load"]) : router.cpuLoad,
          freeMemoryMb: mb(r["free-memory"]) ?? router.freeMemoryMb,
          totalMemoryMb: mb(r["total-memory"]) ?? router.totalMemoryMb,
        },
      }).catch(() => {});
    }
  }

  return plainText("OK");
}
