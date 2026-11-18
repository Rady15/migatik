import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withRouterRow, type RouterLike } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { meter } from "@/lib/tenancy";
import {
  clientIp,
  hashEnrollToken,
  isValidEnrollToken,
  makeRateLimiter,
  plainText,
  sanitizeHost,
} from "@/lib/router-enroll";

/**
 * PUBLIC — enrollment callback executed by the router itself (via /tool fetch).
 *
 *   GET /api/onboard/callback/<token>?a=<router-ip>
 *
 * 1. validates the token (pending, not expired),
 * 2. creates the Router row with the generated API credentials,
 * 3. tries every plausible address (reported IP → request source IP) with a
 *    REAL RouterOS API login, and keeps the first one that authenticates,
 * 4. stores the real identity/version/board read from the device.
 *
 * Nothing here claims "online" unless the device actually answered.
 */
export const dynamic = "force-dynamic";
const allow = makeRateLimiter(60);

function pathToken(req: NextRequest): string {
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

interface DeviceInfo {
  identity?: string;
  version?: string;
  boardName?: string;
  uptime?: string;
  cpuLoad?: number | null;
  freeMemoryMb?: number | null;
  totalMemoryMb?: number | null;
  freeDiskMb?: number | null;
  totalDiskMb?: number | null;
}

async function probe(
  base: RouterLike,
  host: string,
): Promise<{ ok: boolean; info?: DeviceInfo }> {
  const res = await withRouterRow<DeviceInfo>(
    { ...base, host },
    async (conn) => {
      const identityRes = await runCommand(conn, ["/system/identity/print"], 6000);
      const resourceRes = await runCommand(conn, ["/system/resource/print"], 6000);
      if (!identityRes.ok) throw new Error(identityRes.error ?? "identity read failed");
      const r = resourceRes.ok ? resourceRes.data[0] ?? {} : {};
      const mb = (v?: string) => (v ? Math.floor(Number(v) / 1024 / 1024) : null);
      return {
        identity: identityRes.data[0]?.name,
        version: r["version"],
        boardName: r["board-name"],
        uptime: r["uptime"],
        cpuLoad: r["cpu-load"] ? Number(r["cpu-load"]) : null,
        freeMemoryMb: mb(r["free-memory"]),
        totalMemoryMb: mb(r["total-memory"]),
        freeDiskMb: mb(r["free-hdd-space"]),
        totalDiskMb: mb(r["total-hdd-space"]),
      };
    },
    { connectTimeoutMs: 6000, commandTimeoutMs: 6000 },
  );
  return { ok: res.ok, info: res.value };
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  if (!allow(ip)) return plainText("ERROR too-many-requests", 429);

  const token = pathToken(req);
  if (!isValidEnrollToken(token)) return plainText("ERROR invalid-token", 404);

  const enrollment = await db.routerEnrollment.findUnique({ where: { tokenHash: hashEnrollToken(token) } });
  if (!enrollment) return plainText("ERROR invalid-token", 404);
  if (enrollment.routerId) return plainText("OK already-enrolled");
  if (enrollment.status !== "pending") return plainText("ERROR canceled-or-expired", 410);
  if (enrollment.expiresAt.getTime() < Date.now()) {
    await db.routerEnrollment.update({ where: { id: enrollment.id }, data: { status: "expired" } }).catch(() => {});
    return plainText("ERROR expired", 410);
  }

  // Candidate addresses, most trustworthy first: the manually entered IP, every
  // address the router reported, then the source address of the request itself.
  const reported = (req.nextUrl.searchParams.get("a") ?? "").split(",").map((s) => sanitizeHost(s));
  const candidates = Array.from(new Set(
    [
      enrollment.host,
      ...reported,
      sanitizeHost(ip),
    ].filter(Boolean) as string[],
  ));
  if (!candidates.length) return plainText("ERROR no-address", 400);

  try {
    const router = await db.router.create({
      data: {
        organizationId: enrollment.organizationId,
        name: enrollment.name,
        host: candidates[0],
        apiPort: 8728,
        apiSslPort: 8729,
        useTls: false,
        apiUsername: enrollment.apiUsername,
        apiPasswordEnc: enrollment.apiPasswordEnc,
        location: enrollment.location,
        category: enrollment.category,
        connectionMethod: "direct",
        notes: "أُضيف تلقائياً عبر أمر الربط السريع (enrollment)",
        status: "untested",
      },
    });

    // Claim the enrollment atomically — a double callback must not create two routers.
    const claimed = await db.routerEnrollment.updateMany({
      where: { id: enrollment.id, status: "pending", routerId: null },
      data: { status: "installed", routerId: router.id, installedAt: new Date(), host: candidates[0] },
    });
    if (claimed.count === 0) {
      await db.router.delete({ where: { id: router.id } }).catch(() => {});
      return plainText("OK already-enrolled");
    }

    const base = {
      id: router.id,
      name: router.name,
      host: router.host,
      apiPort: router.apiPort,
      apiSslPort: router.apiSslPort,
      useTls: router.useTls,
      apiUsername: router.apiUsername,
      apiPasswordEnc: router.apiPasswordEnc,
      connectionMethod: router.connectionMethod,
      agentId: router.agentId,
    };

    let winner: string | null = null;
    let info: DeviceInfo | undefined;
    const errors: string[] = [];
    for (const host of candidates.slice(0, 5)) {
      const attempt = await probe(base, host);
      if (attempt.ok) {
        winner = host;
        info = attempt.info;
        break;
      }
      errors.push(`${host}: unreachable`);
    }

    await db.router.update({
      where: { id: router.id },
      data: winner
        ? {
            host: winner,
            status: "online",
            statusMessage: null,
            lastOnlineAt: new Date(),
            lastCheckedAt: new Date(),
            identity: info?.identity ?? null,
            version: info?.version ?? null,
            boardName: info?.boardName ?? null,
            uptime: info?.uptime ?? null,
            cpuLoad: info?.cpuLoad ?? null,
            freeMemoryMb: info?.freeMemoryMb ?? null,
            totalMemoryMb: info?.totalMemoryMb ?? null,
            freeDiskMb: info?.freeDiskMb ?? null,
            totalDiskMb: info?.totalDiskMb ?? null,
          }
        : {
            status: "offline",
            statusMessage:
              `أُضيف السيرفر لكن API غير قابل للوصول من المنصة (${errors.join(" · ")}) — ` +
              "تأكد من أن عنوان الراوتر أو المنفذ 8728 يمكن الوصول إليه، أو عدّل عنوان السيرفر يدوياً",
            lastCheckedAt: new Date(),
          },
    });

    await db.routerEnrollment.update({ where: { id: enrollment.id }, data: { host: winner ?? candidates[0] } });
    await db.activityLog.create({
      data: {
        organizationId: enrollment.organizationId,
        actor: "enroll",
        action: "router:auto_enrolled",
        target: enrollment.name,
        details: winner ? `online via ${winner}` : `created, API unreachable (${errors.join(" · ")})`,
      },
    }).catch(() => {});
    await meter(enrollment.organizationId, "routers", 1);

    return plainText(winner ? `OK mtcm-enrolled ${router.id}` : `OK mtcm-created-offline ${router.id}`);
  } catch (e) {
    console.error("[onboard] callback error:", (e as Error).message);
    return plainText("ERROR server", 500);
  }
}
