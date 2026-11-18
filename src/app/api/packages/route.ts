import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { importRouterProfiles } from "@/lib/package-sync";
import { deleteRouterProfile, upsertRouterProfile } from "@/lib/package-router-sync";

const lastImportAt = new Map<string, number>();
const g = globalThis as typeof globalThis & { __mcm_orphanPkgsPurged?: boolean };

/** Router-imported packages are tied to a router. When that router is deleted,
 *  Prisma sets routerId=null on them, leaving phantom packages with no server.
 *  Only `[router-import]` rows are purged — hand-made global packages survive. */
async function purgeOrphanPackages() {
  const routers = await db.router.findMany({ select: { id: true } });
  const validIds = new Set(routers.map((r) => r.id));
  const pkgs = await db.package.findMany({ select: { id: true, routerId: true, description: true } });
  const orphans = pkgs.filter(
    (p) => p.description?.startsWith("[router-import]") && (!p.routerId || !validIds.has(p.routerId)),
  ).map((p) => p.id);
  if (!orphans.length) return 0;
  const where = { id: { in: orphans } };
  const byPkg = { packageId: { in: orphans } };
  await db.voucher.deleteMany({ where: byPkg }).catch(() => {});
  await db.voucherBatch.deleteMany({ where: byPkg }).catch(() => {});
  await db.hotspotUser.deleteMany({ where: byPkg }).catch(() => {});
  await db.subscriber.deleteMany({ where: byPkg }).catch(() => {});
  await db.customer.deleteMany({ where: byPkg }).catch(() => {});
  await db.recurringSubscription.deleteMany({ where: byPkg }).catch(() => {});
  await db.package.deleteMany({ where }).catch(() => {});
  return orphans.length;
}

export const GET = withOrg(async (req: NextRequest, ctx: OrgContext) => {
  try {
    const sp = req.nextUrl.searchParams;
    // Repair phantom router-imported packages left by old non-cascading deletes.
    if (!g.__mcm_orphanPkgsPurged) {
      const removed = await purgeOrphanPackages();
      if (removed) console.log(`[packages] purged ${removed} orphan router-imported packages`);
      g.__mcm_orphanPkgsPurged = true;
    }
    const routerId = sp.get("routerId");

    // RouterOS hotspot profiles are the real package source; keep the app in sync.
    const scope = `${ctx.effectiveOrgId ?? "global"}:${routerId ?? "all"}`;
    const now = Date.now();
    if (sp.get("sync") === "1" || now - (lastImportAt.get(scope) ?? 0) > 15000) {
      lastImportAt.set(scope, now);
      await importRouterProfiles(routerId && routerId !== "all" ? [routerId] : undefined).catch(() => {});
    }

    const packages = await db.package.findMany({
      where: routerId && routerId !== "all" ? { OR: [{ routerId }, { routerId: null }] } : {},
      orderBy: { createdAt: "asc" },
      include: { router: { select: { id: true, name: true } }, _count: { select: { hotspotUsers: true } } },
    });
    return NextResponse.json({ packages });
  } catch (e) {
    return serverError(e);
  }
});

/** Resolve an explicit router or fall back to the first managed real router. */
async function resolveRouter(routerId: unknown) {
  return routerId
    ? db.router.findFirst({ where: { id: String(routerId) } })
    : db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
}

/** SQLite has no case-insensitive `mode`, so compare profile names in JS. */
async function packageWithProfile(routerId: string | null, profile: string) {
  const rows = await db.package.findMany({
    where: routerId ? { routerId } : {},
    select: { id: true, profile: true, name: true },
  });
  return rows.find((p) => (p.profile || "").trim().toLowerCase() === profile.trim().toLowerCase());
}

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.name) return NextResponse.json({ error: "اسم الباقة مطلوب" }, { status: 400 });

    const router = await resolveRouter(b.routerId);
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });

    const name = String(b.name).trim();
    const profile = String(b.profile || "").trim() || name;
    const duplicate = await packageWithProfile(router.id, profile);
    if (duplicate) {
      return NextResponse.json({ error: `الباقة "${duplicate.name}" تستخدم البروفايل "${profile}" على هذا السيرفر بالفعل` }, { status: 409 });
    }

    // Writer order matters: create the real RouterOS hotspot profile FIRST.
    // A DB row is only stored once the router confirms the profile exists.
    const routerWrite = await upsertRouterProfile(router, {
      currentName: profile,
      desiredName: profile,
      downMbps: Number(b.downloadMbps) || 1,
      upMbps: Number(b.uploadMbps) || 1,
    });
    if (!routerWrite.ok) {
      return NextResponse.json({ error: `تعذر إنشاء الباقة على الراوتر: ${routerWrite.error ?? "خطأ غير معروف"}` }, { status: 502 });
    }

    const pkg = await db.package.create({
      data: {
        name,
        description: b.description ? String(b.description) : null,
        downloadMbps: Number(b.downloadMbps) || 1,
        uploadMbps: Number(b.uploadMbps) || 1,
        dataLimitMb: b.dataLimitMb ? Number(b.dataLimitMb) : null,
        durationHours: Number(b.durationHours) || 720,
        price: Number(b.price) || 0,
        profile,
        routerId: router.id,
        active: b.active !== false,
      },
    });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "إضافة باقة",
        target: pkg.name,
        details: `profile=${profile} router=${router.name} rosId=${routerWrite.rosId ?? "?"}`,
      },
    });
    return NextResponse.json({ ok: true, pkg, routerSynced: true, routerProfile: profile, routerName: router.name });
  } catch (e) {
    return serverError(e);
  }
});
