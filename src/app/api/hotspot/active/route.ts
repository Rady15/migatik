import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import { runCommand } from "@/lib/routeros";

/**
 * GET /api/hotspot/active — LIVE active Hotspot sessions from the router.
 * Query params: routerId (optional), status, mac, username, ip, count-only, count
 * Response contract kept identical to the previous implementation (now real data).
 */
export const GET = async (req: NextRequest) => {
  try {
    const sp = req.nextUrl.searchParams;
    const routerId = sp.get("routerId");

    const router = routerId
      ? await db.router.findFirst({ where: { id: routerId } })
      : await db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
    if (!router) {
      return NextResponse.json({ error: "لا يوجد سيرفر مُعد — أضف سيرفراً أولاً", users: [], total: 0 }, { status: 404 });
    }

    const res = await withRouterCredentials(router.id, (conn) =>
      runCommand(conn, ["/ip/hotspot/active/print"], 10000),
    );
    if (!res.ok || !res.value) {
      return NextResponse.json({ error: res.error ?? "تعذر الاتصال بالسيرفر", users: [], total: 0 }, { status: 502 });
    }
    if (!res.value.ok) {
      return NextResponse.json({ error: res.value.error ?? "فشل قراءة الجلسات النشطة", users: [], total: 0 }, { status: 502 });
    }

    // Map real RouterOS attrs → existing API contract
    let users = res.value.data.map((u) => ({
      id: u[".id"] ?? "",
      user: u["user"] ?? "",
      address: u["address"] ?? "",
      mac_address: u["mac-address"] ?? "",
      login_by: u["login-by"] ?? "",
      uptime: u["uptime"] ?? "",
      idle_time: u["idle-time"] ?? "",
      idle_timeout: u["keepalive-timeout"] ?? "",
      bytes_in: Number(u["bytes-in"] ?? 0),
      bytes_out: Number(u["bytes-out"] ?? 0),
      packets_in: Number(u["packets-in"] ?? 0),
      packets_out: Number(u["packets-out"] ?? 0),
      radius: u["radius"] === "true",
      server: u["server"] ?? "",
    }));

    const status = sp.get("status");
    const mac = sp.get("mac");
    const username = sp.get("username");
    const ip = sp.get("ip");
    const countOnly = sp.get("count-only") === "true";
    const countOnlyNum = countOnly ? Number(sp.get("count")) : undefined;

    if (status) users = users.filter((u) => u.user === status || u.idle_time === status);
    if (mac) users = users.filter((u) => u.mac_address === mac);
    if (username) users = users.filter((u) => u.user === username);
    if (ip) users = users.filter((u) => u.address === ip);

    if (countOnly) {
      const total = users.length;
      return NextResponse.json({ total, count: countOnlyNum ? Math.min(countOnlyNum, total) : total });
    }

    return NextResponse.json({
      total: users.length,
      page: 1,
      pageSize: users.length,
      router: { id: router.id, name: router.name },
      fetchedAt: new Date().toISOString(),
      users: users.map((u) => ({
        id: u.id,
        username: u.user,
        address: u.address,
        mac: u.mac_address,
        login_by: u.login_by,
        uptime: u.uptime,
        idle_time: u.idle_time,
        idle_timeout: u.idle_timeout,
        bytes_in: u.bytes_in,
        bytes_out: u.bytes_out,
        packets_in: u.packets_in,
        packets_out: u.packets_out,
        radius: u.radius,
        server: u.server,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, users: [], total: 0 }, { status: 500 });
  }
};
