import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import { runCommand } from "@/lib/routeros";

/**
 * GET /api/hotspot/host — LIVE Hotspot host table from the router.
 * Query params: routerId (optional), mac, ip, count-only
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
      return NextResponse.json({ error: "لا يوجد سيرفر مُعد — أضف سيرفراً أولاً", hosts: [], total: 0 }, { status: 404 });
    }

    const res = await withRouterCredentials(router.id, (conn) =>
      runCommand(conn, ["/ip/hotspot/host/print"], 10000),
    );
    if (!res.ok || !res.value) {
      return NextResponse.json({ error: res.error ?? "تعذر الاتصال بالسيرفر", hosts: [], total: 0 }, { status: 502 });
    }
    if (!res.value.ok) {
      return NextResponse.json({ error: res.value.error ?? "فشل قراءة جدول المضيفين", hosts: [], total: 0 }, { status: 502 });
    }

    let hosts = res.value.data.map((h) => ({
      id: h[".id"] ?? "",
      mac: h["mac-address"] ?? "",
      ip: h["address"] ?? "",
      interface: h["server"] ?? "",
      status: h["authorized"] === "true" ? "authorized" : h["bypassed"] === "true" ? "bypassed" : "unknown",
      uptime: h["uptime"] ?? "",
      idle_time: h["idle-time"] ?? "",
      server: h["server"] ?? "",
      bytes_in: Number(h["bytes-in"] ?? 0),
      bytes_out: Number(h["bytes-out"] ?? 0),
      packets_in: Number(h["packets-in"] ?? 0),
      packets_out: Number(h["packets-out"] ?? 0),
      found_by: h["found-by"] ?? "",
      dhcp: h["DHCP"] === "true",
      last_seen: new Date().toISOString(),
    }));

    const mac = sp.get("mac");
    const ip = sp.get("ip");
    const count_only = sp.get("count-only") === "true";

    if (mac) hosts = hosts.filter((h) => h.mac === mac);
    if (ip) hosts = hosts.filter((h) => h.ip === ip);

    if (count_only) {
      return NextResponse.json({ total: hosts.length });
    }

    return NextResponse.json({
      total: hosts.length,
      page: 1,
      pageSize: hosts.length,
      router: { id: router.id, name: router.name },
      fetchedAt: new Date().toISOString(),
      hosts: hosts.map((h) => ({
        id: h.id,
        mac: h.mac,
        ip: h.ip,
        interface: h.interface,
        status: h.status,
        last_seen: h.last_seen,
        bytes_in: h.bytes_in,
        bytes_out: h.bytes_out,
        packets_in: h.packets_in,
        packets_out: h.packets_out,
        uptime: h.uptime,
        idle_time: h.idle_time,
        server: h.server,
        found_by: h.found_by,
        dhcp: h.dhcp,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, hosts: [], total: 0 }, { status: 500 });
  }
};
