import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { formatLimitUptime } from "@/lib/voucher-actions";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    const current = await db.hotspotUser.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (b.username !== undefined) data.username = String(b.username);
    if (b.password !== undefined && b.password !== "") data.password = String(b.password);
    if (b.fullName !== undefined) data.fullName = String(b.fullName);
    if (b.phone !== undefined) data.phone = String(b.phone);
    if (b.status !== undefined) data.status = String(b.status);
    if (b.packageId !== undefined) data.packageId = b.packageId || null;
    if (b.routerId !== undefined && b.routerId !== "") data.routerId = String(b.routerId);
    if (b.expiresAt !== undefined) data.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    if (Object.keys(data).length === 0) return NextResponse.json({ error: "لا توجد تغييرات" }, { status: 400 });

    let pkgRow: any = null;
    if (b.packageId) {
      pkgRow = await db.package.findFirst({ where: { id: String(b.packageId) } });
      if (!pkgRow) return NextResponse.json({ error: "الباقة غير موجودة" }, { status: 400 });
    }

    const targetRouterId = b.routerId && b.routerId !== "" ? String(b.routerId) : current.routerId;
    const router = targetRouterId
      ? await db.router.findFirst({ where: { id: targetRouterId } })
      : await db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
    if (routerTouched(b) && !router) {
      return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });
    }

    // Resolve the profile the router should use: explicit > selected package > current.
    let profile = b.profile ? String(b.profile).trim() : "";
    if (!profile && pkgRow) {
      profile = (pkgRow.profile || pkgRow.name || "").trim();
    }
    if (!profile) profile = current.profile || "default";

    // Mirror every router-backed field in one write BEFORE changing the DB.
    // If the router rejects it, the local row stays untouched and truthful.
    let routerUpdated = false;
    let routerNote: string | undefined;
    if (routerTouched(b) && router && current.routerSynced) {
      const username = String(data.username ?? current.username);
      const password = String(data.password ?? current.password ?? "");
      const disabled = String(data.status ?? current.status) === "suspended" || String(data.status ?? current.status) === "expired" ? "yes" : "no";
      const limitUptime = formatLimitUptime(pkgRow?.durationHours);
      const limitBytesTotal = pkgRow?.dataLimitMb ? Number(pkgRow.dataLimitMb) * 1024 * 1024 : 0;
      const limitWords = [
        ...(limitUptime ? [`=limit-uptime=${limitUptime}`] : []),
        ...(limitBytesTotal > 0 ? [`=limit-bytes-total=${Math.floor(limitBytesTotal)}`] : []),
      ];
      const res = await withRouterRow(router, async (conn) => {
        const find = await runCommand(conn, ["/ip/hotspot/user/print"]);
        const uid = find.data.find((r) => (r.name ?? "").toLowerCase() === current.username.toLowerCase())?.[".id"];
        if (uid) {
          const set = await runCommand(conn, [
            "/ip/hotspot/user/set",
            `=.id=${uid}`,
            `=name=${username}`,
            `=password=${password}`,
            `=profile=${profile}`,
            `=disabled=${disabled}`,
            ...limitWords,
          ]);
          return { ok: set.ok, error: set.error, mode: "set" };
        }
        // User was removed directly in WebFig/CLI since the last import —
        // recreate it from the DB rather than silently pretending it was edited.
        const add = await runCommand(conn, [
          "/ip/hotspot/user/add",
          `=name=${username}`,
          `=password=${password}`,
          `=profile=${profile}`,
          `=disabled=${disabled}`,
          `=comment=mcm:${ctx.username}`,
          ...limitWords,
        ]);
        return { ok: add.ok, error: add.error, mode: "recreated" };
      });
      if (!res.ok || !res.value?.ok) {
        return NextResponse.json({
          error: `تعذر تعديل المستخدم على الراوتر: ${res.error ?? res.value?.error ?? "خطأ غير معروف"}`,
        }, { status: 502 });
      }
      routerUpdated = true;
      routerNote = res.value.mode === "recreated" ? "أُعيد إنشاء المستخدم على الراوتر لأنه كان محذوفاً هناك" : undefined;

      if (router.id !== current.routerId && current.routerId) {
        const oldRouter = await db.router.findFirst({ where: { id: current.routerId } });
        if (oldRouter) {
          const cleanup = await withRouterRow(oldRouter, async (conn) => {
            const find = await runCommand(conn, ["/ip/hotspot/user/print"]);
            const uid = find.data.find((r) => (r.name ?? "").toLowerCase() === current.username.toLowerCase())?.[".id"];
            return uid ? runCommand(conn, ["/ip/hotspot/user/remove", `=.id=${uid}`]) : null;
          }).catch(() => null);
          if (!cleanup?.value?.ok) routerNote = `${routerNote ?? ""} تنبيه: لم يُحذف المستخدم القديم من السيرفر السابق`.trim();
        }
      }
      data.profile = profile;
      if (pkgRow && b.expiresAt === undefined && pkgRow.durationHours) {
        data.expiresAt = new Date(Date.now() + Number(pkgRow.durationHours) * 3600_000);
      }
    }

    const user = await db.hotspotUser.update({ where: { id }, data });
    await db.activityLog.create({
      data: { actor: ctx.username, action: "تعديل مستخدم", target: user.username, details: `routerUpdated=${routerUpdated}${routerNote ? ` (${routerNote})` : ""}` },
    });
    return NextResponse.json({ ok: true, routerUpdated, routerNote });
  } catch (e) {
    return serverError(e);
  }
});

function routerTouched(b: Record<string, unknown>): boolean {
  return ["username", "password", "status", "packageId", "routerId", "profile"].some((k) => b[k] !== undefined);
}

interface DeleteProbe {
  removed: boolean;
  /** entry vanished from the router between print and remove */
  missing?: boolean;
  /** RouterOS built-in template (e.g. default-trial) — read-only on the device */
  builtIn?: boolean;
  /** auto-created entry (MAC login) — removed by RouterOS itself */
  dynamic?: boolean;
  error?: string;
}

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = await routeId(req);
    const user = await db.hotspotUser.findUnique({ where: { id } });
    if (!user) return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });

    // Mirror the deletion on the real router so WebFig stays in sync.
    let routerRemoved = false;
    let routerError: string | undefined;
    let routerNote: string | undefined;
    if (user.routerSynced) {
      let router = user.routerId ? await db.router.findFirst({ where: { id: user.routerId } }) : null;
      if (!router) router = await db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
      if (router) {
        const res = await withRouterRow<DeleteProbe>(router, async (conn) => {
          // Print ALL users and filter locally — avoids RouterOS query-word edge
          // cases and matches the proven ROS-manager read pattern.
          const find = await runCommand(conn, [`/ip/hotspot/user/print`]);
          if (!find.ok) return { removed: false, error: `read-failed: ${find.error}` };
          // RouterOS returns the internal id as the `.id` attribute (word
          // "=.id=*N"), so it must be read as r[".id"] — r.id is always
          // undefined and made every user look absent from the router.
          const row = find.data.find((r) => (r.name ?? "").toLowerCase() === user.username.toLowerCase());
          if (!row || !row[".id"]) return { removed: false, missing: true };
          // Built-in / auto-created entries are not deletable by design:
          // "default" is a template row, "dynamic" belongs to an active session.
          if (row.default === "true") return { removed: false, builtIn: true };
          if (row.dynamic === "true") return { removed: false, dynamic: true };
          const del = await runCommand(conn, ["/ip/hotspot/user/remove", `=.id=${row[".id"]}`]);
          if (del.ok) return { removed: true };
          const err = del.error ?? "";
          if (/no such item/i.test(err)) return { removed: false, missing: true };
          if (/default/i.test(err)) return { removed: false, builtIn: true };
          if (/dynamic/i.test(err)) return { removed: false, dynamic: true };
          return { removed: false, error: err };
        });
        routerRemoved = !!res.value?.removed;
        routerError = res.ok ? res.value?.error : res.error;
        if (!routerRemoved && res.value?.builtIn) {
          routerNote = "هذا عنصر مدمج في RouterOS (default) ولا يمكن حذفه من الراوتر — أُزيل من التطبيق فقط";
        } else if (!routerRemoved && res.value?.dynamic) {
          routerNote = "هذا مستخدم ديناميكي على RouterOS ينشأ تلقائياً — أُزيل من التطبيق فقط";
        } else if (!routerRemoved && !res.value?.missing) {
          // Connection failure or a real RouterOS rejection: keep the DB row so
          // the UI never claims a user was removed when WebFig still shows it.
          return NextResponse.json({
            error: `تعذر حذف المستخدم من الراوتر: ${routerError ?? "خطأ غير معروف"}`,
            routerRemoved: false,
          }, { status: 502 });
        }
      } else {
        routerError = "no-router-row";
        return NextResponse.json({ error: "تعذر العثور على السيرفر المرتبط بالمستخدم", routerRemoved: false }, { status: 502 });
      }
    } else {
      routerError = "routerSynced=false";
    }

    await db.hotspotUser.delete({ where: { id } });
    await db.activityLog.create({ data: { actor: ctx.username, action: "حذف مستخدم", target: user.username, details: `routerRemoved=${routerRemoved}${routerNote ? ` (${routerNote})` : ""}${routerError ? ` (${routerError})` : ""}` } });
    return NextResponse.json({ ok: true, routerRemoved, routerError, routerNote });
  } catch (e) {
    return serverError(e);
  }
});
