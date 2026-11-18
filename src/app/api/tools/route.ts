import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { runCommand } from "@/lib/routeros";
import { withRouterRow } from "@/lib/router-transport";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";

/**
 * Authorized network tools executed through the RouterOS API of the selected router.
 * Honest errors when the router is unreachable.
 */
export const POST = withOrgStrict(async (req: NextRequest) => {
  try {
    const b = await req.json();
    const tool = String(b.tool || "ping");
    const routerId = String(b.routerId || "");
    const target = String(b.address || "").trim();
    if (!routerId) return NextResponse.json({ error: "اختر السيرفر أولاً" }, { status: 400 });
    if (!target) return NextResponse.json({ error: "أدخل العنوان" }, { status: 400 });
    if (!/^[\w.\-:]+$/.test(target)) return NextResponse.json({ error: "عنوان غير صالح" }, { status: 400 });

    const router = await db.router.findFirst({ where: { id: routerId } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });

    const commands: Record<string, string[]> = {
      ping: ["/ping", `=address=${target}`, "=count=4"],
      traceroute: ["/tool/traceroute", `=address=${target}`, "=count=3"],
      dns: ["/resolve", `=name=${target}`],
      arp: ["/ip/arp/print"],
      dhcp: ["/ip/dhcp-server/lease/print"],
      routes: ["/ip/route/print"],
      connections: ["/ip/firewall/connection/print", "=count=30"],
      interfaces: ["/interface/print"],
    };
    const cmd = commands[tool];
    if (!cmd) return NextResponse.json({ error: "أداة غير مدعومة" }, { status: 400 });

    const res = await withRouterRow(router, (conn) => runCommand(conn, cmd), { commandTimeoutMs: 15000 });
    if (!res.ok) {
      await db.router.update({ where: { id: routerId }, data: { status: "offline", statusMessage: res.error, lastCheckedAt: new Date() } });
      return NextResponse.json({ ok: false, error: res.error }, { status: 502 });
    }
    const rows = res.value!.data;
    if (tool === "ping") {
      const pings = rows.map((r) => ({ time: r.time, host: r.host, seq: r.seq, status: "ok" }));
      const times = pings.map((p) => parseFloat(p.time)).filter((n) => !isNaN(n));
      return NextResponse.json({
        ok: true,
        tool,
        summary: times.length ? `متوسط زمن الاستجابة ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms من ${pings.length} رزم` : "لا توجد ردود من الهدف",
        rows: pings,
      });
    }
    return NextResponse.json({ ok: true, tool, rows: rows.slice(0, 60), summary: `${rows.length} سجل` });
  } catch (e) {
    return serverError(e);
  }
});
