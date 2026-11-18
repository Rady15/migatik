import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import {
  dhcpLeaseMakeStatic, dhcpLeaseAddStatic, dhcpLeaseRemove, dhcpLeaseSetDisabled,
  disconnectHotspotSession, disconnectPppSession, type ActionResult,
} from "@/lib/discovery/actions";

/**
 * POST /api/network/action — DHCP lease + session management operations.
 * All operations execute real RouterOS commands; destructive ones need confirm=true.
 */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const routerId = String(body.routerId ?? "");
    const mac = String(body.mac ?? "");
    const confirm = body.confirm === true;
    if (!routerId) return badRequest("routerId مطلوب");

    const router = await db.router.findFirst({ where: { id: routerId } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });

    const needsConfirm: Record<string, boolean> = {
      lease_remove: true, lease_disable: false, lease_enable: false,
      lease_make_static: false, lease_add_static: false,
      hotspot_disconnect: true, ppp_disconnect: true,
    };
    if (needsConfirm[action] && !confirm) {
      return badRequest("تتطلب هذه العملية تأكيداً صريحاً (confirm=true) بعد مراجعة التفاصيل");
    }

    const result = await withRouterCredentials(routerId, async (conn) => {
      const actx = { conn, routerId, actor: ctx.username };
      switch (action) {
        case "lease_make_static": return dhcpLeaseMakeStatic(actx, mac);
        case "lease_add_static": return dhcpLeaseAddStatic(actx, mac, String(body.ip ?? ""), body.server ? String(body.server) : undefined, body.comment ? String(body.comment) : undefined);
        case "lease_remove": return dhcpLeaseRemove(actx, mac);
        case "lease_disable": return dhcpLeaseSetDisabled(actx, mac, true);
        case "lease_enable": return dhcpLeaseSetDisabled(actx, mac, false);
        case "hotspot_disconnect": return disconnectHotspotSession(actx, body.username ? String(body.username) : undefined, mac || undefined);
        case "ppp_disconnect": return disconnectPppSession(actx, String(body.username ?? ""));
        default: return { ok: false, error: `إجراء غير معروف: ${action}` };
      }
    });

    if (!result.ok) return badRequest(result.error ?? "فشل تنفيذ العملية على السيرفر");
    const value = result.value as ActionResult | undefined;
    await db.activityLog.create({
      data: { actor: ctx.username, action: `network:${action}`, target: mac || body.username || routerId, details: value?.detail ?? "" },
    }).catch(() => {});
    return NextResponse.json(value ?? { ok: true });
  } catch (e) {
    return serverError(e);
  }
});
