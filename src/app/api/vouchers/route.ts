import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { voucherCredential } from "@/lib/voucher-auth";
import { syncVoucherUsage } from "@/lib/voucher-lifecycle";

export const GET = withOrg(async (req: NextRequest) => {
  try {
    // A card used on a phone must not stay "unused" just because the admin is
    // on this page instead of the dashboard. Throttled inside the helper.
    await syncVoucherUsage().catch(() => {});

    const sp = req.nextUrl.searchParams;
    const batchId = sp.get("batchId");
    const status = sp.get("status");
    const search = sp.get("search")?.trim();
    const routerId = sp.get("routerId");
    const page = Math.max(1, Number(sp.get("page") || 1));
    // print mode allows large batches (batch printing of up to 5000 cards)
    const pageSize = Math.min(sp.get("print") === "1" ? 5000 : 200, Math.max(5, Number(sp.get("pageSize") || 20)));
    const where: Record<string, unknown> = {};
    if (batchId && batchId !== "all") where.batchId = batchId;
    if (status && status !== "all") where.status = status;
    if (routerId && routerId !== "all") where.routerId = routerId;
    if (search) where.OR = [{ username: { contains: search } }, { serial: { contains: search } }];
    const [total, vouchers, batches] = await Promise.all([
      db.voucher.count({ where }),
      db.voucher.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
        include: { package: { select: { name: true, downloadMbps: true, uploadMbps: true, durationHours: true } }, router: { select: { name: true } }, batch: { select: { name: true } } },
      }),
      db.voucherBatch.findMany({ where: routerId && routerId !== "all" ? { routerId } : {}, orderBy: { createdAt: "desc" }, include: { package: { select: { name: true } }, router: { select: { name: true } } } }),
    ]);
    const stats = await db.voucher.groupBy({ by: ["status"], where, _count: true });
    // credentials are decrypted server-side for the authenticated admin view only
    // (at rest the DB stores AES-256-GCM encrypted values for v3 rows)
    const safeVouchers = vouchers.map((v) => ({
      ...v,
      password: v.authMode === "username_only" ? "" : voucherCredential(v),
    }));
    return NextResponse.json({ total, page, pageSize, vouchers: safeVouchers, batches, stats });
  } catch (e) {
    return serverError(e);
  }
});
