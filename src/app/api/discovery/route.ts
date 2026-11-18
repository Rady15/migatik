import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { triggerSyncNow } from "@/lib/discovery/sync-engine";

/** GET /api/discovery — recent discovery jobs (health + logs of the sync engine). */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const jobId = req.nextUrl.searchParams.get("jobId");
    if (jobId) {
      const logs = await db.discoveryJobLog.findMany({ where: { jobId }, orderBy: { ts: "asc" }, take: 200 });
      return NextResponse.json({ logs });
    }
    const routerId = req.nextUrl.searchParams.get("routerId");
    const jobs = await db.discoveryJob.findMany({
      where: routerId && routerId !== "all" ? { routerId } : {},
      orderBy: { startedAt: "desc" },
      take: 20,
      include: { router: { select: { name: true } } },
    });
    const routers = await db.router.findMany({
      where: { isDemo: false },
      select: { id: true, name: true, host: true, status: true, syncEnabled: true, syncIntervalSec: true, lastSyncAt: true, lastSyncOk: true, lastSyncError: true, nextSyncAt: true, syncFailCount: true, isDemo: true },
    });
    return NextResponse.json({ jobs: jobs.map((j) => ({
      id: j.id, router: j.router.name, routerId: j.routerId, type: j.type, trigger: j.trigger,
      status: j.status, sourcesDone: JSON.parse(j.sourcesDone || "[]"), sourcesFailed: JSON.parse(j.sourcesFailed || "[]"),
      stats: JSON.parse(j.stats || "{}"), error: j.error, durationMs: j.durationMs, startedAt: j.startedAt, finishedAt: j.finishedAt,
    })), routers });
  } catch (e) {
    return serverError(e);
  }
});

/** POST /api/discovery — trigger a manual sync now (routerId optional = all). */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const body = await req.json().catch(() => ({}));
    const routerId = body.routerId && body.routerId !== "all" ? String(body.routerId) : undefined;
    // the target router (when not "all") must belong to the same organization
    if (routerId) {
      const router = await db.router.findFirst({ where: { id: routerId } });
      if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });
    }
    const results = await triggerSyncNow(routerId);
    await db.activityLog.create({
      data: { actor: ctx.username, action: "تشغيل مزامنة الاكتشاف", target: routerId ?? "all", details: JSON.stringify(results.map((r) => ({ ok: r.ok, error: r.error }))) },
    }).catch(() => {});
    return NextResponse.json({ results });
  } catch (e) {
    return serverError(e);
  }
});
