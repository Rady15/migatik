import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { badRequest, serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterRow } from "@/lib/router-transport";
import { removeVoucherUser, setVoucherUserDisabled, upsertVoucherUser, formatLimitUptime } from "@/lib/voucher-actions";
import { ensureVoucherSale } from "@/lib/voucher-sales";

/**
 * Actions for existing cards/batches. Every router-backed action is applied on
 * the device first; only confirmed rows are then updated in the local DB.
 */
const ACTIONS = ["mark_sold", "activate", "reactivate", "resync", "expire", "delete", "delete_batch", "sync_batch"] as const;
type Action = (typeof ACTIONS)[number];

const DESTRUCTIVE: Action[] = ["delete", "delete_batch"];

type Target = Awaited<ReturnType<typeof loadTargets>>[number];

async function loadTargets(body: { ids?: unknown; batchId?: unknown }) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const batchId = body.batchId ? String(body.batchId) : "";
  if (batchId && batchId !== "all") {
    return db.voucher.findMany({
      where: { batchId },
      include: { router: true, package: true, batch: true },
      orderBy: { createdAt: "asc" },
    });
  }
  if (ids.length) {
    return db.voucher.findMany({
      where: { id: { in: ids } },
      include: { router: true, package: true, batch: true },
    });
  }
  return [];
}

function profileOf(v: Target): string {
  return (v.package?.profile || v.batch?.profile || "default").trim() || "default";
}

function expiryOf(v: Target): Date {
  const hours = Number(v.batch?.validityHours || v.package?.durationHours || 720);
  return new Date(Date.now() + (hours > 0 ? hours : 720) * 3600_000);
}

function limitsOf(v: Target) {
  return {
    limitUptime: formatLimitUptime(v.batch?.validityHours || v.package?.durationHours),
    limitBytesTotal: v.package?.dataLimitMb ? Number(v.package.dataLimitMb) * 1024 * 1024 : undefined,
  };
}

/**
 * A card and its hotspot user are the same identity (same username on the same
 * router). Deleting the card removes the user from the router above — this also
 * drops the row the importer created on the Users page, otherwise the deleted
 * card keeps showing up there forever.
 */
async function purgeHotspotUsers(vouchers: Target[]): Promise<number> {
  // Local-only cards never created a router user — never touch a same-named
  // manual user in that case.
  const withRouter = vouchers.filter((v) => Boolean(v.routerId));
  const names = Array.from(new Set(withRouter.map((v) => v.username.trim().toLowerCase()).filter(Boolean)));
  if (!names.length) return 0;
  const routerIds = Array.from(new Set(withRouter.map((v) => v.routerId!)));
  const rows = await db.hotspotUser.findMany({
    where: routerIds.length ? { routerId: { in: routerIds } } : {},
    select: { id: true, username: true },
  });
  const ids = rows.filter((r) => names.includes(r.username.trim().toLowerCase())).map((r) => r.id);
  if (!ids.length) return 0;
  return (await db.hotspotUser.deleteMany({ where: { id: { in: ids } } })).count;
}

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) return badRequest(`إجراء غير معروف: ${action}`);
    if (DESTRUCTIVE.includes(action) && body.confirm !== true) {
      return badRequest("تتطلب عمليات الحذف تأكيداً صريحاً (confirm=true)");
    }
    if ((action === "delete_batch" || action === "sync_batch") && !body.batchId) {
      return badRequest("batchId مطلوب لهذا الإجراء");
    }

    const targets = await loadTargets({ ids: body.ids, batchId: body.batchId });
    if (!targets.length) {
      if (action === "delete_batch" && body.batchId) {
        await db.voucherBatch.deleteMany({ where: { id: String(body.batchId) } }).catch(() => {});
        return NextResponse.json({ ok: true, changed: 1, failed: 0, errors: [], message: "تم حذف الدفعة الفارغة" });
      }
      return badRequest("لا توجد كروت مطابقة");
    }

    const routerGroups = new Map<string, { router: NonNullable<Target["router"]>; items: Target[] }>();
    const localOnly: Target[] = [];
    for (const v of targets) {
      if (!v.router) {
        localOnly.push(v);
        continue;
      }
      const key = v.router.id;
      if (!routerGroups.has(key)) routerGroups.set(key, { router: v.router, items: [] });
      routerGroups.get(key)!.items.push(v);
    }

    const results: { id: string; ok: boolean; error?: string; detail?: string; mode?: string }[] = [];
    const needsRouter = action !== "mark_sold";

    for (const { router, items } of routerGroups.values()) {
      if (!needsRouter) {
        results.push(...items.map((v) => ({ id: v.id, ok: true, detail: "local" })));
        continue;
      }
      const res = await withRouterRow(router, async (conn) => {
        const out: typeof results = [];
        for (const v of items) {
          try {
            if (action === "activate" || action === "reactivate" || action === "resync") {
              const r = await upsertVoucherUser(conn, v, profileOf(v), false, limitsOf(v));
              out.push({ id: v.id, ok: r.ok, error: r.error, mode: r.mode, detail: `router ${r.mode ?? "upsert"}` });
            } else if (action === "expire") {
              const r = await setVoucherUserDisabled(conn, v.username, true);
              out.push({ id: v.id, ok: r.ok, error: r.error, detail: r.missing ? "already absent" : "disabled" });
            } else if (action === "delete" || action === "delete_batch") {
              const r = await removeVoucherUser(conn, v.username);
              out.push({ id: v.id, ok: r.ok, error: r.error, detail: r.missing ? "not-on-router" : "removed" });
            }
          } catch (e) {
            out.push({ id: v.id, ok: false, error: (e as Error).message });
          }
        }
        return out;
      });
      if (!res.ok || !res.value) {
        results.push(...items.map((v) => ({ id: v.id, ok: false, error: res.error ?? "تعذر الاتصال بالراوتر" })));
      } else {
        results.push(...res.value);
      }
    }

    if (!needsRouter) {
      results.push(...localOnly.map((v) => ({ id: v.id, ok: true, detail: "local" })));
    } else {
      results.push(...localOnly.map((v) => ({
        id: v.id,
        ok: false,
        error: "الكرت غير مرتبط بسيرفر — لا يمكن تنفيذ إجراء على الراوتر",
      })));
    }

    const okIds = results.filter((r) => r.ok).map((r) => r.id);
    const failures = results.filter((r) => !r.ok);
    let changed = 0;
    let purgedUsers = 0;

    if (okIds.length) {
      if (action === "delete" || action === "delete_batch") {
        changed = (await db.voucher.deleteMany({ where: { id: { in: okIds } } })).count;
        // Keep the Users page truthful: the card's hotspot user is gone.
        purgedUsers = await purgeHotspotUsers(targets.filter((v) => okIds.includes(v.id)));
        if (action === "delete_batch" && body.batchId) {
          await db.voucherBatch.deleteMany({ where: { id: String(body.batchId) } }).catch(() => {});
        }
      } else {
        const byId = new Map(targets.map((v) => [v.id, v]));
        for (const id of okIds) {
          const v = byId.get(id);
          if (!v) continue;
          const data: Record<string, unknown> = {};
          if (action === "mark_sold") {
            data.status = "sold";
            data.soldAt = new Date();
          } else if (action === "activate" || action === "reactivate") {
            data.status = "activated";
            data.activatedAt = new Date();
            data.expiresAt = expiryOf(v);
            data.routerSynced = true;
            data.syncError = null;
          } else if (action === "resync") {
            data.routerSynced = true;
            data.syncError = null;
            if (v.status === "pending_sync" || v.status === "failed") data.status = "unused";
          } else if (action === "expire") {
            data.status = "expired";
          }
          if (Object.keys(data).length) {
            await db.voucher.update({ where: { id }, data });
            changed++;
          }
          // A sold/activated card is money in: invoice + payment + ledger (idempotent).
          if (action === "mark_sold" || action === "activate" || action === "reactivate") {
            await ensureVoucherSale(id).catch(() => {});
          }
        }

        // Keep batch health truthful after mass resync.
        if ((action === "sync_batch" || action === "resync") && body.batchId) {
          const batchId = String(body.batchId);
          const [all, synced] = await Promise.all([
            db.voucher.count({ where: { batchId } }),
            db.voucher.count({ where: { batchId, routerSynced: true } }),
          ]);
          const status = synced === all ? "completed" : synced > 0 ? "partial" : "failed";
          await db.voucherBatch.update({ where: { id: batchId }, data: { status, syncedCount: synced } }).catch(() => {});
        }
      }
    }

    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: `voucher:${action}`,
        target: body.batchId ? String(body.batchId) : `${okIds.length} cards`,
        details: `changed=${changed} purgedUsers=${purgedUsers} failed=${failures.length}${failures.length ? ` errors=${failures.slice(0, 3).map((f) => f.error).join(" | ")}` : ""}`,
      },
    }).catch(() => {});

    return NextResponse.json({
      ok: failures.length === 0,
      changed,
      purgedUsers,
      failed: failures.length,
      errors: failures.slice(0, 10),
      message: failures.length
        ? `تم تنفيذ ${changed} إجراء وفشل ${failures.length}`
        : `تم تنفيذ الإجراء بنجاح على ${changed} كرت`,
    });
  } catch (e) {
    return serverError(e);
  }
});
