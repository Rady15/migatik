import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import {
  previewBlock, applyBlock, applyUnblock, dhcpLeaseMakeStatic, dhcpLeaseAddStatic,
  dhcpLeaseRemove, dhcpLeaseSetDisabled, dhcpLeaseSetComment,
  disconnectHotspotSession, disconnectPppSession, icmpCheck,
} from "@/lib/discovery/actions";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

/** POST /api/devices/[id]/actions — device control with preview + explicit confirmation. */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const device = await db.networkDevice.findFirst({ where: { id } });
    if (!device) return NextResponse.json({ error: "الجهاز غير موجود" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const confirm = body.confirm === true;

    // previews never touch the router
    if (action === "block_preview") {
      const preview = await previewBlock(device.routerId, device.macAddress, String(body.method ?? "firewall_forward_drop"));
      if (!preview.ok) return badRequest(preview.error ?? "تعذر إنشاء المعاينة");
      return NextResponse.json({ preview });
    }

    // everything below performs real RouterOS operations
    const result = await withRouterCredentials(device.routerId, async (conn) => {
      const ctxA = { conn, routerId: device.routerId, actor: ctx.username };
      switch (action) {
        case "block": {
          if (!confirm) return { ok: false, error: "تتطلب هذه العملية تأكيداً صريحاً (confirm=true) بعد مراجعة المعاينة" };
          const r = await applyBlock(ctxA, device.macAddress, String(body.method ?? "firewall_forward_drop"));
          if (r.ok) {
            await db.networkDevice.update({ where: { id }, data: { status: "blocked", trustStatus: "blocked", blockedAt: new Date() } });
            await db.deviceEvent.create({ data: { deviceId: id, type: "blocked", details: r.detail ?? "", source: body.method ?? "firewall_forward_drop" } });
            await db.activityLog.create({ data: { actor: ctx.username, action: "حجب جهاز", target: device.macAddress, details: `${r.detail ?? ""} على ${device.routerId}` } });
          }
          return r;
        }
        case "unblock": {
          const r = await applyUnblock(ctxA, device.macAddress);
          if (r.ok) {
            await db.networkDevice.update({ where: { id }, data: { status: "unknown", trustStatus: "unknown", blockedAt: null } });
            await db.deviceEvent.create({ data: { deviceId: id, type: "unblocked", details: r.detail ?? "" } });
            await db.activityLog.create({ data: { actor: ctx.username, action: "إلغاء حجب جهاز", target: device.macAddress } });
          }
          return r;
        }
        case "reserve_ip": {
          if (!device.ipAddress) return { ok: false, error: "لا يوجد عنوان IP معروف لهذا الجهاز بعد" };
          const hasLease = await dhcpLeaseMakeStatic(ctxA, device.macAddress, device.ipAddress);
          if (hasLease.ok) {
            await db.deviceEvent.create({ data: { deviceId: id, type: "commented", details: "تم تحويل الإيجار إلى حجز ثابت (reserve IP)" } });
            return hasLease;
          }
          // no lease on router — create a static reservation
          return dhcpLeaseAddStatic(ctxA, device.macAddress, device.ipAddress, undefined, "MCM reserved");
        }
        case "rename": {
          const name = String(body.name ?? "").trim();
          if (!name) return { ok: false, error: "الاسم مطلوب" };
          await db.networkDevice.update({ where: { id }, data: { customName: name, isNew: false } });
          await db.deviceEvent.create({ data: { deviceId: id, type: "renamed", oldValue: device.customName, newValue: name } });
          return { ok: true, detail: "تم حفظ الاسم" };
        }
        case "comment": {
          const comment = String(body.comment ?? "").trim();
          await db.networkDevice.update({ where: { id }, data: { comment, isNew: false } });
          await db.deviceEvent.create({ data: { deviceId: id, type: "commented", newValue: comment } });
          const lease = await dhcpLeaseSetComment(ctxA, device.macAddress, comment).catch(() => ({ ok: false }));
          return { ok: true, detail: lease.ok ? "تم حفظ الملاحظة + مزامنتها مع تعليق الإيجار على السيرفر" : "تم حفظ الملاحظة محلياً (لا يوجد إيجار على السيرفر)" };
        }
        case "trust": {
          await db.networkDevice.update({ where: { id }, data: { trustStatus: "trusted", isNew: false } });
          await db.deviceEvent.create({ data: { deviceId: id, type: "trusted" } });
          return { ok: true, detail: "تم وسم الجهاز كجهاز موثوق" };
        }
        case "mark_suspicious": {
          await db.networkDevice.update({ where: { id }, data: { trustStatus: "suspicious", isNew: false } });
          await db.deviceEvent.create({ data: { deviceId: id, type: "suspicious" } });
          return { ok: true, detail: "تم وسم الجهاز كمشتبه به" };
        }
        case "categorize": {
          const category = String(body.category ?? "unknown");
          await db.networkDevice.update({ where: { id }, data: { deviceCategory: category, isNew: false } });
          await db.deviceEvent.create({ data: { deviceId: id, type: "categorized", newValue: category } });
          return { ok: true, detail: "تم تحديد نوع الجهاز" };
        }
        case "disconnect_hotspot": {
          if (!confirm) return { ok: false, error: "تتطلب تأكيداً صريحاً" };
          return disconnectHotspotSession(ctxA, undefined, device.macAddress);
        }
        case "ping": {
          if (!device.ipAddress) return { ok: false, error: "لا يوجد عنوان IP" };
          return icmpCheck(ctxA, device.ipAddress);
        }
        case "clear_new": {
          await db.networkDevice.updateMany({ where: { id }, data: { isNew: false } });
          return { ok: true, detail: "تم المراجعة" };
        }
        default:
          return { ok: false, error: `إجراء غير معروف: ${action}` };
      }
    });

    if (!result.ok) return badRequest(result.error ?? "فشل الإجراء على السيرفر");
    return NextResponse.json(result);
  } catch (e) {
    return serverError(e);
  }
});

/** DELETE /api/devices/[id] — remove the local record (never touches the router). */
export const DELETE = withOrgStrict(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    await db.networkDevice.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
