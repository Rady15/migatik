import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";
import { deleteRouterProfile, upsertRouterProfile } from "@/lib/package-router-sync";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export const PATCH = withOrgStrict(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    const current = await db.package.findUnique({ where: { id }, include: { router: true } });
    if (!current) return NextResponse.json({ error: "الباقة غير موجودة" }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (b.name !== undefined) data.name = String(b.name);
    if (b.description !== undefined) data.description = String(b.description);
    if (b.downloadMbps !== undefined) data.downloadMbps = Number(b.downloadMbps);
    if (b.uploadMbps !== undefined) data.uploadMbps = Number(b.uploadMbps);
    if (b.dataLimitMb !== undefined) data.dataLimitMb = b.dataLimitMb ? Number(b.dataLimitMb) : null;
    if (b.durationHours !== undefined) data.durationHours = Number(b.durationHours);
    if (b.price !== undefined) data.price = Number(b.price);
    if (b.profile !== undefined) data.profile = String(b.profile);
    // The edit dialog sends an empty routerId when untouched — keep the link.
    if (b.routerId !== undefined && b.routerId !== "") data.routerId = String(b.routerId);
    if (b.active !== undefined) data.active = Boolean(b.active);
    if (Object.keys(data).length === 0) return NextResponse.json({ error: "لا توجد تغييرات" }, { status: 400 });

    if (b.routerId && b.routerId !== current.routerId) {
      const router = await db.router.findFirst({ where: { id: String(b.routerId) } });
      if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });
    }

    const routerTouched = ["name", "profile", "downloadMbps", "uploadMbps", "routerId"].some(
      (k) => b[k] !== undefined && !(k === "routerId" && b[k] === ""),
    );
    let routerSynced = false;
    let routerProfile: string | undefined;
    let routerName: string | undefined;
    const oldRouter = current.router;
    const oldProfile = current.profile || current.name;

    if (routerTouched && oldRouter) {
      const targetRouterId = b.routerId && b.routerId !== "" ? String(b.routerId) : oldRouter.id;
      const router = targetRouterId === oldRouter.id
        ? oldRouter
        : await db.router.findFirst({ where: { id: targetRouterId } });
      if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });

      const desiredName = String(data.profile ?? current.profile ?? current.name).trim() || String(data.name ?? current.name).trim();
      const down = Number(data.downloadMbps ?? current.downloadMbps);
      const up = Number(data.uploadMbps ?? current.uploadMbps);

      const write = await upsertRouterProfile(router, {
        currentName: oldProfile,
        desiredName,
        downMbps: down,
        upMbps: up,
      });
      if (!write.ok) {
        return NextResponse.json({ error: `تعذر تعديل الباقة على الراوتر: ${write.error ?? "خطأ غير معروف"}` }, { status: 502 });
      }
      routerSynced = true;
      routerProfile = desiredName;
      routerName = router.name;

      // Moving a package to another router: remove the old profile only after
      // the new one is confirmed, so we never lose the package on failure.
      if (router.id !== oldRouter.id && oldRouter.id) {
        const cleanup = await deleteRouterProfile(oldRouter, oldProfile);
        if (!cleanup.ok && !cleanup.missing) {
          // Keep the new profile; report the stale copy instead of rolling back.
          routerProfile = `${desiredName} (تنبيه: لم يُحذف البروفايل القديم: ${cleanup.error})`;
        }
      }
    }

    await db.package.update({ where: { id }, data });
    return NextResponse.json({ ok: true, routerSynced, routerProfile, routerName });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const pkg = await db.package.findUnique({ where: { id }, include: { router: true } });
    if (!pkg) return NextResponse.json({ error: "الباقة غير موجودة" }, { status: 404 });

    const inUse = await db.hotspotUser.count({ where: { packageId: id } });
    if (inUse > 0) {
      return NextResponse.json({ error: `لا يمكن الحذف — الباقة مستخدمة بواسطة ${inUse} مستخدم. قم بإلغاء تفعيلها بدلاً من ذلك.` }, { status: 409 });
    }

    let routerRemoved = false;
    let routerNote: string | undefined;
    if (pkg.router) {
      const result = await deleteRouterProfile(pkg.router, pkg.profile || pkg.name);
      if (!result.ok && !result.missing) {
        return NextResponse.json({ error: `تعذر حذف البروفايل من الراوتر: ${result.error ?? "خطأ غير معروف"}` }, { status: 502 });
      }
      routerRemoved = !result.missing;
      routerNote = result.missing ? "البروفايل غير موجود على الراوتر — حُذف السجل المحلي فقط" : result.detail;
    } else {
      routerNote = "الباقة غير مرتبطة بسيرفر — حُذف السجل المحلي فقط";
    }

    await db.package.delete({ where: { id } });
    return NextResponse.json({ ok: true, routerRemoved, routerNote });
  } catch (e) {
    return serverError(e);
  }
});
