import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";

const KEYS = ["discovery_grace_min", "discovery_notify_new", "discovery_notify_offline", "discovery_interface_traffic"];

/** GET /api/discovery/settings — detection policies (Setting model is global). */
export const GET = withOrg(async () => {
  const rows = await db.setting.findMany({ where: { key: { in: KEYS } } });
  return NextResponse.json({
    settings: {
      discovery_grace_min: rows.find((r) => r.key === "discovery_grace_min")?.value ?? "5",
      discovery_notify_new: rows.find((r) => r.key === "discovery_notify_new")?.value ?? "true",
      discovery_notify_offline: rows.find((r) => r.key === "discovery_notify_offline")?.value ?? "false",
      discovery_interface_traffic: rows.find((r) => r.key === "discovery_interface_traffic")?.value ?? "true",
    },
  });
});

/** PUT /api/discovery/settings — update detection policies. */
export const PUT = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const body = await req.json();
    for (const key of KEYS) {
      if (body[key] !== undefined) {
        await db.setting.upsert({
          where: { key },
          create: { key, value: String(body[key]) },
          update: { value: String(body[key]) },
        });
      }
    }
    // per-router sync interval (only for routers owned by the organization)
    if (body.routerIntervals) {
      for (const [routerId, interval] of Object.entries(body.routerIntervals)) {
        const sec = Math.max(15, Math.min(3600, parseInt(String(interval), 10) || 60));
        const router = await db.router.findFirst({ where: { id: routerId } });
        if (!router) continue;
        await db.router.update({ where: { id: routerId }, data: { syncIntervalSec: sec } }).catch(() => {});
      }
    }
    await db.activityLog.create({ data: { actor: ctx.username, action: "تحديث إعدادات الاكتشاف", details: JSON.stringify(body) } }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
