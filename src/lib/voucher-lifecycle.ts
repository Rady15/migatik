import { db } from "@/lib/db";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { setVoucherUserDisabled } from "@/lib/voucher-actions";
import { ensureVoucherSale } from "@/lib/voucher-sales";

/**
 * Voucher lifecycle automation.
 *
 * Two gaps this fills:
 *  1. A card used on a phone stayed "unused" in the panel forever, because
 *     nothing mapped real RouterOS activity back to the Voucher row.
 *  2. A card that reached its validity end was never marked expired, and the
 *     hotspot user stayed enabled on the router.
 *
 * Policy (deliberate):
 *  - First login  → status "activated", activatedAt set, expiresAt = now + validity
 *                   (unless the batch uses the "immediate" activation policy and
 *                   expiresAt was already stamped at generation time).
 *  - Time is up   → status "expired", the router user is DISABLED and any live
 *                   session is kicked. The row is never deleted, so sales/reports
 *                   keep the history and the card can be reactivated on demand.
 */

const DEFAULT_VALIDITY_HOURS = 720;

interface ValiditySource {
  batch?: { validityHours: number | null } | null;
  package?: { durationHours: number | null } | null;
}

function validityHoursOf(v: ValiditySource): number {
  const hours = Number(v.batch?.validityHours ?? 0) || Number(v.package?.durationHours ?? 0) || DEFAULT_VALIDITY_HOURS;
  return hours > 0 ? hours : DEFAULT_VALIDITY_HOURS;
}

/**
 * Mark every voucher of `routerId` whose username shows real activity as used.
 * Case-insensitive because RouterOS may report the login differently.
 */
export async function markVouchersUsedByUsernames(routerId: string, usernames: string[]): Promise<number> {
  const wanted = new Set(usernames.map((u) => u.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return 0;

  const pending = await db.voucher.findMany({
    where: { routerId, status: { in: ["unused", "sold", "pending_sync", "activated"] } },
    select: {
      id: true,
      username: true,
      soldAt: true,
      activatedAt: true,
      expiresAt: true,
      batch: { select: { validityHours: true } },
      package: { select: { durationHours: true } },
    },
  });

  const matches = pending.filter((v) => wanted.has(v.username.toLowerCase()));
  if (matches.length === 0) return 0;

  const now = new Date();
  for (const v of matches) {
    const hours = validityHoursOf(v);
    await db.voucher
      .update({
        where: { id: v.id },
        data: {
          // A card that was really used is a SOLD card: the customer paid for it.
          status: "sold",
          soldAt: v.soldAt ?? now,
          activatedAt: v.activatedAt ?? now,
          expiresAt: v.expiresAt ?? new Date(now.getTime() + hours * 3600_000),
        },
      })
      .catch(() => {});
    // Record the money once (invoice + payment + ledger); no-op if already done.
    await ensureVoucherSale(v.id).catch(() => {});
  }
  return matches.length;
}

export interface ExpireResult {
  expired: number;
  disabled: number;
  errors: string[];
}

/**
 * Mark vouchers whose expiresAt has passed as expired and stop them on the
 * router (disable the hotspot user + kick an active session). Best-effort: a
 * router that is offline never blocks the DB status update.
 */
export async function expireDueVouchers(): Promise<ExpireResult> {
  const out: ExpireResult = { expired: 0, disabled: 0, errors: [] };
  const now = new Date();

  const due = await db.voucher.findMany({
    where: { expiresAt: { lte: now }, status: { in: ["unused", "sold", "activated"] } },
    take: 1000,
    select: { id: true, username: true, routerId: true, router: true },
  });
  if (due.length === 0) return out;

  const changed = await db.voucher.updateMany({
    where: { id: { in: due.map((v) => v.id) } },
    data: { status: "expired" },
  });
  out.expired = changed.count;

  const groups = new Map<string, { router: NonNullable<(typeof due)[number]["router"]>; usernames: string[] }>();
  for (const v of due) {
    if (!v.router) continue;
    const g = groups.get(v.router.id) ?? { router: v.router, usernames: [] };
    g.usernames.push(v.username);
    groups.set(v.router.id, g);
  }

  for (const { router, usernames } of groups.values()) {
    const res = await withRouterRow(router, async (conn) => {
      let disabled = 0;
      for (const username of usernames) {
        const r = await setVoucherUserDisabled(conn, username, true);
        if (r.ok) disabled++;

        // Terminate a session that is still running, so expiry takes effect now.
        const active = await runCommand(conn, ["/ip/hotspot/active/print", `?user=${username}`]);
        if (active.ok) {
          for (const row of active.data) {
            if (row[".id"]) await runCommand(conn, ["/ip/hotspot/active/remove", `=.id=${row[".id"]}`]);
          }
        }
      }
      return disabled;
    });
    if (res.ok && typeof res.value === "number") out.disabled += res.value;
    else out.errors.push(`${router.name || router.host}: ${res.error ?? "تعذر إيقاف الكروت على الراوتر"}`);
  }

  return out;
}

/** Background job: expire vouchers every 5 minutes (one instance per process). */
export function ensureVoucherScheduler(): void {
  const g = globalThis as unknown as { __mcm_voucher_scheduler?: ReturnType<typeof setInterval> };
  if (g.__mcm_voucher_scheduler) return;
  console.log("[vouchers] expiry scheduler started (every 5 min)");
  g.__mcm_voucher_scheduler = setInterval(() => {
    expireDueVouchers()
      .then((r) => {
        if (r.expired > 0) console.log(`[vouchers] expired=${r.expired} disabledOnRouter=${r.disabled}`);
        if (r.errors.length > 0) console.error("[vouchers] expiry errors:", r.errors.slice(0, 3).join(" | "));
      })
      .catch((e) => console.error("[vouchers] scheduler tick error:", (e as Error).message));
  }, 5 * 60_000);
  g.__mcm_voucher_scheduler.unref?.();
}
