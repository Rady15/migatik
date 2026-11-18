import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { connectRouterOS, runCommand } from "@/lib/routeros";

async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) {
    const resolved = await p;
    if (resolved.id) return resolved.id;
  }
  // Fallback: extract from URL path /api/routers/<id>/test
  const parts = req.nextUrl.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("routers");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return "";
}

function notFoundOr500(e: unknown) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
    return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });
  }
  return serverError(e);
}

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const router = await db.router.findUnique({
      where: { id },
      select: { id: true, name: true, host: true, apiPort: true, apiSslPort: true, useTls: true, apiUsername: true, apiPasswordEnc: true, connectionMethod: true, agentId: true },
    });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });

    const password = decryptSecret(router.apiPasswordEnc);
    const start = Date.now();
    const port = router.useTls ? router.apiSslPort : router.apiPort;

    const connRes = await connectRouterOS({
      host: router.host,
      port,
      useTls: router.useTls,
      username: router.apiUsername,
      password,
      connectTimeoutMs: 8000,
      commandTimeoutMs: 5000,
    });

    if (!connRes.ok || !connRes.conn) {
      await db.router.update({ where: { id }, data: { status: "offline", statusMessage: connRes.error } });
      return NextResponse.json({ ok: false, error: connRes.error }, { status: 502 });
    }

    const identityRes = await runCommand(connRes.conn, ["/system/identity/print"]);
    const resourceRes = await runCommand(connRes.conn, ["/system/resource/print"]);
    connRes.conn.close();

    const latencyMs = Date.now() - start;
    const identity = identityRes.ok && identityRes.data[0] ? identityRes.data[0].name : router.name;
    const version = resourceRes.ok && resourceRes.data[0] ? resourceRes.data[0]["version"] : null;
    const boardName = resourceRes.ok && resourceRes.data[0] ? resourceRes.data[0]["board-name"] : null;
    const uptime = resourceRes.ok && resourceRes.data[0] ? resourceRes.data[0]["uptime"] : null;
    const cpuLoad = resourceRes.ok && resourceRes.data[0] ? Number(resourceRes.data[0]["cpu-load"] ?? 0) : null;
    const freeMemoryMb = resourceRes.ok && resourceRes.data[0] ? Math.floor((Number(resourceRes.data[0]["free-memory"] ?? 0)) / 1024 / 1024) : null;
    const totalMemoryMb = resourceRes.ok && resourceRes.data[0] ? Math.floor((Number(resourceRes.data[0]["total-memory"] ?? 0)) / 1024 / 1024) : null;
    const freeDiskMb = resourceRes.ok && resourceRes.data[0] ? Math.floor((Number(resourceRes.data[0]["free-hdd-space"] ?? 0)) / 1024 / 1024) : null;
    const totalDiskMb = resourceRes.ok && resourceRes.data[0] ? Math.floor((Number(resourceRes.data[0]["total-hdd-space"] ?? 0)) / 1024 / 1024) : null;

    await db.router.update({
      where: { id },
      data: {
        status: "online",
        statusMessage: null,
        lastOnlineAt: new Date(),
        lastCheckedAt: new Date(),
        identity,
        version,
        boardName,
        uptime,
        cpuLoad,
        freeMemoryMb,
        totalMemoryMb,
        freeDiskMb,
        totalDiskMb,
      },
    });

    return NextResponse.json({
      ok: true,
      latencyMs,
      info: { identity, version, boardName, uptime, cpuLoad, freeMemoryMb, totalMemoryMb, freeDiskMb, totalDiskMb },
    });
  } catch (e) {
    return notFoundOr500(e);
  }
});