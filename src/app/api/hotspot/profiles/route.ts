import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import { runCommand } from "@/lib/routeros";

/**
 * GET /api/hotspot/profiles — LIVE Hotspot user profiles from the router.
 * Query params: routerId (optional), name, rate_limit, shared_users, count-only
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
      return NextResponse.json({ error: "لا يوجد سيرفر مُعد — أضف سيرفراً أولاً", profiles: [], total: 0 }, { status: 404 });
    }

    const res = await withRouterCredentials(router.id, (conn) =>
      runCommand(conn, ["/ip/hotspot/user/profile/print"], 10000),
    );
    if (!res.ok || !res.value) {
      return NextResponse.json({ error: res.error ?? "تعذر الاتصال بالسيرفر", profiles: [], total: 0 }, { status: 502 });
    }
    if (!res.value.ok) {
      return NextResponse.json({ error: res.value.error ?? "فشل قراءة البروفايلات", profiles: [], total: 0 }, { status: 502 });
    }

    // rate-limit in RouterOS is "rx/tx" (e.g. "10M/10M"); split for the legacy fields
    const splitRate = (rate: string): [string, string] => {
      if (!rate || rate === "none" || rate === "0/0") return ["0", "0"];
      const [a, b] = rate.split("/");
      return [a ?? "0", b ?? a ?? "0"];
    };

    let profiles = res.value.data.map((p) => {
      const rate = p["rate-limit"] ?? "none";
      const [down, up] = splitRate(rate);
      return {
        id: p[".id"] ?? "",
        name: p["name"] ?? "",
        rate_limit: rate,
        shared_users: p["shared-users"] ?? "",
        session_timeout: p["session-timeout"] ?? p["idle-timeout"] ?? "",
        bandwidth_in: down,
        bandwidth_out: up,
        login_by: p["login-by"] ?? "",
        status: p["disabled"] === "true" ? "disabled" : "valid",
        idle_timeout: p["idle-timeout"] ?? "",
        keepalive_timeout: p["keepalive-timeout"] ?? "",
        comment: p["comment"] ?? "",
      };
    });

    const name = sp.get("name");
    const rate_limit = sp.get("rate_limit");
    const shared_users = sp.get("shared_users");
    const count_only = sp.get("count-only") === "true";

    if (name) profiles = profiles.filter((p) => p.name === name);
    if (rate_limit) profiles = profiles.filter((p) => p.rate_limit === rate_limit);
    if (shared_users !== null) profiles = profiles.filter((p) => p.shared_users === shared_users);

    if (count_only) {
      return NextResponse.json({ total: profiles.length });
    }

    return NextResponse.json({
      total: profiles.length,
      page: 1,
      pageSize: profiles.length,
      router: { id: router.id, name: router.name },
      fetchedAt: new Date().toISOString(),
      profiles: profiles.map((p) => ({
        name: p.name,
        rate_limit: p.rate_limit,
        shared_users: p.shared_users,
        session_timeout: p.session_timeout,
        bandwidth_in: p.bandwidth_in,
        bandwidth_out: p.bandwidth_out,
        login_by: p.login_by,
        status: p.status,
        idle_timeout: p.idle_timeout,
        keepalive_timeout: p.keepalive_timeout,
        comment: p.comment,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, profiles: [], total: 0 }, { status: 500 });
  }
};
