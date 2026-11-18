import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";

/** GET /api/branches — organizations + branches with live counts for assignment UIs. */
export const GET = withOrg(async (_req: NextRequest, ctx: OrgContext) => {
  try {
    // Organization is a global (platform) model — scope it manually for tenant sessions.
    const organizations = await db.organization.findMany(ctx.effectiveOrgId ? { where: { id: ctx.effectiveOrgId } } : undefined);
    const branches = await db.branch.findMany({
      orderBy: { createdAt: "asc" },
      include: { organization: { select: { name: true, code: true } } },
    });
    const counts = await Promise.all(branches.map(async (br) => ({
      id: br.id,
      routers: await db.router.count({ where: { branchId: br.id } }),
      subscribers: await db.subscriber.count({ where: { branchId: br.id } }),
      employees: await db.adminUser.count({ where: { branchId: br.id } }),
      agents: await db.networkAgent.count({ where: { branchId: br.id } }),
    })));
    return NextResponse.json({ organizations, branches, counts });
  } catch (e) {
    return serverError(e);
  }
});

/** POST /api/branches — create organization or branch. */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (b.type === "organization") {
      const name = String(b.name ?? "").trim();
      const code = String(b.code ?? name.toUpperCase().replace(/\s+/g, "-")).trim();
      if (!name || !code) return badRequest("اسم المنظمة والرمز مطلوبان");
      if (await db.organization.findUnique({ where: { code } })) return badRequest("رمز المنظمة موجود مسبقاً");
      const org = await db.organization.create({ data: { name, code } });
      await db.activityLog.create({ data: { actor: ctx.username, action: "branch:org_created", target: name } });
      return NextResponse.json({ ok: true, organization: org });
    }
    const name = String(b.name ?? "").trim();
    const code = String(b.code ?? name.toUpperCase().replace(/\s+/g, "-")).trim();
    if (!name || !code) return badRequest("اسم الفرع والرمز مطلوبان");
    if (await db.branch.findUnique({ where: { code } })) return badRequest("رمز الفرع موجود مسبقاً");
    const branch = await db.branch.create({
      data: {
        name, code,
        // branches always belong to the active organization (never trust a cross-tenant organizationId from the body)
        organizationId: ctx.effectiveOrgId,
        phone: b.phone ? String(b.phone) : null,
        address: b.address ? String(b.address) : null,
      },
    });
    await db.activityLog.create({ data: { actor: ctx.username, action: "branch:created", target: name } });
    return NextResponse.json({ ok: true, branch });
  } catch (e) {
    if ((e as Error).message.includes("Unique constraint")) return badRequest("الرمز موجود مسبقاً");
    return serverError(e);
  }
});

/** PATCH /api/branches — assign routers / employees / subscribers to a branch. */
export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    const branchId = b.branchId || null; // null = unassign
    if (branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(branchId) } });
      if (!branch) return badRequest("الفرع غير موجود");
    }
    const results: Record<string, number> = {};
    if (Array.isArray(b.routerIds)) {
      const r = await db.router.updateMany({ where: { id: { in: b.routerIds.map(String) } }, data: { branchId } });
      results.routers = r.count;
    }
    if (Array.isArray(b.userIds)) {
      const r = await db.adminUser.updateMany({ where: { id: { in: b.userIds.map(String) } }, data: { branchId } });
      results.employees = r.count;
    }
    if (Array.isArray(b.subscriberIds)) {
      const r = await db.subscriber.updateMany({ where: { id: { in: b.subscriberIds.map(String) } }, data: { branchId } });
      results.subscribers = r.count;
    }
    await db.activityLog.create({
      data: { actor: ctx.username, action: "branch:assign", target: branchId ?? "(unassign)", details: JSON.stringify(results) },
    });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return serverError(e);
  }
});
