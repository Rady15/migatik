import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { recordEvent } from "@/lib/subscribers";
import { importRouterSubscribers } from "@/lib/subscriber-sync";

// Avoid a new RouterOS connection on every keystroke / page change.
const lastImportAt = new Map<string, number>();
const g = globalThis as typeof globalThis & { __mcm_orphanSubsPurged?: boolean };

/** Legacy server deletes left Subscriber rows with routerId=null (Prisma SetNull).
 *  They show up as phantom "active" subscribers with no server. Purge once. */
async function purgeOrphanSubscribers() {
  const routers = await db.router.findMany({ select: { id: true } });
  const validIds = new Set(routers.map((r) => r.id));
  const subs = await db.subscriber.findMany({ select: { id: true, routerId: true } });
  const orphans = subs.filter((s) => !s.routerId || !validIds.has(s.routerId)).map((s) => s.id);
  if (!orphans.length) return 0;
  const where = { id: { in: orphans } };
  // Child rows first (most are Cascade, but be explicit across all tables).
  await db.subscriberEvent.deleteMany({ where: { subscriberId: { in: orphans } } }).catch(() => {});
  await db.recurringSubscription.deleteMany({ where: { subscriberId: { in: orphans } } }).catch(() => {});
  await db.invoice.deleteMany({ where: { subscriberId: { in: orphans } } }).catch(() => {});
  await db.payment.deleteMany({ where: { subscriberId: { in: orphans } } }).catch(() => {});
  await db.customerTx.deleteMany({ where: { subscriberId: { in: orphans } } }).catch(() => {});
  await db.subscriber.deleteMany({ where }).catch(() => {});
  return orphans.length;
}

/** GET /api/subscribers — list with search/status/branch/router filters + KPI. */
export const GET = withOrg(async (req: NextRequest, ctx: OrgContext) => {
  try {
    const sp = req.nextUrl.searchParams;
    // Repair legacy orphan subscribers left by old non-cascading server deletes.
    if (!g.__mcm_orphanSubsPurged) {
      const removed = await purgeOrphanSubscribers();
      if (removed) console.log(`[subscribers] purged ${removed} orphan subscribers`);
      g.__mcm_orphanSubsPurged = true;
    }
    const search = sp.get("search")?.trim().toLowerCase() ?? "";
    const status = sp.get("status");
    const branchId = sp.get("branchId");
    const routerId = sp.get("routerId");
    const page = Math.max(1, Number(sp.get("page") || 1));
    const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize") || 20)));

    // Bring in accounts that exist on the router but were never registered here.
    const scope = `${ctx.effectiveOrgId ?? "global"}:${routerId ?? "all"}`;
    const now = Date.now();
    if (sp.get("sync") === "1" || now - (lastImportAt.get(scope) ?? 0) > 15000) {
      lastImportAt.set(scope, now);
      await importRouterSubscribers(routerId && routerId !== "all" ? [routerId] : undefined).catch(() => {});
    }

    const where: Record<string, unknown> = {};
    if (status && status !== "all") where.status = status;
    if (branchId && branchId !== "all") where.branchId = branchId;
    if (routerId && routerId !== "all") where.routerId = routerId;

    // Load all matching rows so search + KPI + pagination agree on the totals.
    const allRows = await db.subscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        package: { select: { id: true, name: true, price: true, downloadMbps: true, uploadMbps: true, durationHours: true } },
        router: { select: { id: true, name: true, status: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    const filtered = search
      ? allRows.filter((r) =>
          r.name.toLowerCase().includes(search) ||
          r.code.toLowerCase().includes(search) ||
          (r.username ?? "").toLowerCase().includes(search) ||
          (r.phone ?? "").includes(search) ||
          (r.macAddresses ?? "").toLowerCase().includes(search))
      : allRows;

    const total = filtered.length;
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
    const statusCounts = await db.subscriber.groupBy({ by: ["status"], _count: true });

    // Real RouterOS profile from the matching imported hotspot user — shown as
    // the package when no billing Package is linked (e.g. "1 Mega").
    const usernames = rows.map((s) => s.username).filter(Boolean) as string[];
    const profileByUser = new Map<string, string>();
    if (usernames.length) {
      const hu = await db.hotspotUser.findMany({
        where: { username: { in: usernames } },
        select: { username: true, profile: true },
      });
      for (const u of hu) profileByUser.set(u.username.toLowerCase(), u.profile);
    }

    return NextResponse.json({
      total, page, pageSize,
      subscribers: rows.map((s) => ({
        ...s,
        macAddresses: s.macAddresses ? JSON.parse(s.macAddresses) : [],
        packageName: s.package?.name ?? profileByUser.get((s.username ?? "").toLowerCase()) ?? null,
      })),
      kpi: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
    });
  } catch (e) {
    return serverError(e);
  }
});

/** POST /api/subscribers — register a new subscriber (lifecycle: registration). */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    const name = String(b.name ?? "").trim();
    if (!name) return badRequest("اسم المشترك مطلوب");
    const accountType = ["hotspot", "pppoe", "both"].includes(b.accountType) ? b.accountType : "hotspot";

    // router/branch/package FKs must belong to the same organization
    if (b.routerId) {
      const router = await db.router.findFirst({ where: { id: String(b.routerId) } });
      if (!router) return badRequest("السيرفر غير موجود");
    }
    if (b.branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(b.branchId) } });
      if (!branch) return badRequest("الفرع غير موجود");
    }
    if (b.packageId) {
      const pkg = await db.package.findFirst({ where: { id: String(b.packageId) } });
      if (!pkg) return badRequest("الباقة غير موجودة");
    }

    // unique human-friendly account code
    const year = new Date().getFullYear();
    const count = await db.subscriber.count();
    let code = b.code ? String(b.code).trim() : `SUB-${year}-${String(count + 1).padStart(5, "0")}`;
    if (await db.subscriber.findFirst({ where: { code } })) {
      code = `SUB-${year}-${String(count + 1).padStart(5, "0")}-${Math.floor(Math.random() * 900 + 100)}`;
    }

    const created = await db.subscriber.create({
      data: {
        code, name,
        phone: b.phone ? String(b.phone) : null,
        email: b.email ? String(b.email) : null,
        address: b.address ? String(b.address) : null,
        accountType,
        username: b.username ? String(b.username).trim() : null,
        routerId: b.routerId || null,
        branchId: b.branchId || null,
        packageId: b.packageId || null,
        macAddresses: Array.isArray(b.macAddresses) ? JSON.stringify(b.macAddresses.map((m: string) => m.toUpperCase())) : (b.macAddresses ? JSON.stringify([String(b.macAddresses).toUpperCase()]) : null),
        autoRenew: b.autoRenew === true,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        notes: b.notes ? String(b.notes) : null,
        status: "registered",
      },
    });
    await recordEvent(created.id, "registered", `حساب ${created.code}`, ctx.username);

    // recurring subscription when autoRenew requested (uses the selected package's price)
    if (created.autoRenew && created.packageId) {
      const pkg = await db.package.findUnique({ where: { id: created.packageId } });
      if (pkg) {
        await db.recurringSubscription.create({
          data: {
            subscriberId: created.id,
            packageId: pkg.id,
            routerId: created.routerId,
            cycle: "monthly",
            amount: pkg.price,
            currency: pkg.currency,
            nextRunAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          },
        });
        await recordEvent(created.id, "renewed", `اشتراك متكرر: ${pkg.name} شهرياً ($${pkg.price})`, ctx.username);
      }
    }

    await db.activityLog.create({
      data: { actor: ctx.username, action: "subscriber:registered", target: created.code, details: name },
    });
    return NextResponse.json({ ok: true, subscriber: created });
  } catch (e) {
    return serverError(e);
  }
});
