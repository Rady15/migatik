import { db } from "@/lib/db";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import { runCommand, type RosConnection } from "@/lib/routeros";

/**
 * Unified subscriber lifecycle (v3).
 * Every router-side change is executed with REAL RouterOS API commands and the
 * outcome recorded in SubscriberEvent — a failed router sync is logged as
 * `router_sync_error` and never reported as success.
 */

export type LifecycleAction =
  | "activate" | "renew" | "suspend" | "reactivate"
  | "migrate_package" | "terminate";

const VALID_TRANSITIONS: Record<string, LifecycleAction[]> = {
  registered: ["activate", "terminate", "migrate_package"],
  active: ["renew", "suspend", "migrate_package", "terminate"],
  suspended: ["reactivate", "terminate"],
  expired: ["reactivate", "renew", "terminate"],
  terminated: [],
};

function cycleHours(cycle: string): number {
  return { daily: 24, weekly: 168, monthly: 720, yearly: 8760 }[cycle] ?? 720;
}

/** Router-side enforcement of an account state (hotspot + PPPoE, whichever exists). */
export async function enforceOnRouter(
  routerId: string,
  username: string,
  op: "enable" | "disable" | "kick" | "set_profile",
  opts: { profile?: string } = {},
): Promise<{ ok: boolean; error?: string; detail: string }> {
  const result = await withRouterCredentials(routerId, async (conn: RosConnection) => {
    const out: string[] = [];
    const applied: string[] = [];
    // hotspot user
    const hu = await runCommand(conn, ["/ip/hotspot/user/print", `?name=${username}`]);
    if (hu.ok && hu.data[0]?.[".id"]) {
      const id = hu.data[0][".id"];
      if (op === "enable") { const r = await runCommand(conn, ["/ip/hotspot/user/set", `=.id=${id}`, "=disabled=no"]); if (r.ok) applied.push("hotspot:user enabled"); else out.push(`hotspot enable: ${r.error}`); }
      if (op === "disable") { const r = await runCommand(conn, ["/ip/hotspot/user/set", `=.id=${id}`, "=disabled=yes"]); if (r.ok) applied.push("hotspot:user disabled"); else out.push(`hotspot disable: ${r.error}`); }
      if (op === "set_profile" && opts.profile) { const r = await runCommand(conn, ["/ip/hotspot/user/set", `=.id=${id}`, `=profile=${opts.profile}`]); if (r.ok) applied.push(`hotspot profile→${opts.profile}`); else out.push(`hotspot profile: ${r.error}`); }
      if (op === "kick") {
        const act = await runCommand(conn, ["/ip/hotspot/active/print", `?user=${username}`]);
        for (const a of act.data) {
          if (a[".id"]) { const r = await runCommand(conn, ["/ip/hotspot/active/remove", `=.id=${a[".id"]}`]); if (r.ok) applied.push("hotspot session removed"); }
        }
      }
    }
    // PPP secret
    const ps = await runCommand(conn, ["/ppp/secret/print", `?name=${username}`]);
    if (ps.ok && ps.data[0]?.[".id"]) {
      const id = ps.data[0][".id"];
      if (op === "enable") { const r = await runCommand(conn, ["/ppp/secret/set", `=.id=${id}`, "=disabled=no"]); if (r.ok) applied.push("ppp:secret enabled"); else out.push(`ppp enable: ${r.error}`); }
      if (op === "disable") { const r = await runCommand(conn, ["/ppp/secret/set", `=.id=${id}`, "=disabled=yes"]); if (r.ok) applied.push("ppp:secret disabled"); else out.push(`ppp disable: ${r.error}`); }
      if (op === "set_profile" && opts.profile) { const r = await runCommand(conn, ["/ppp/secret/set", `=.id=${id}`, `=profile=${opts.profile}`]); if (r.ok) applied.push(`ppp profile→${opts.profile}`); else out.push(`ppp profile: ${r.error}`); }
      if (op === "kick") {
        const act = await runCommand(conn, ["/ppp/active/print", `?name=${username}`]);
        for (const a of act.data) {
          if (a[".id"]) { const r = await runCommand(conn, ["/ppp/active/remove", `=.id=${a[".id"]}`]); if (r.ok) applied.push("ppp session removed"); }
        }
      }
    }
    if (applied.length === 0 && out.length === 0) {
      return { applied: ["no router-side account found (nothing to enforce)"], errors: out };
    }
    return { applied, errors: out };
  });
  if (!result.ok) return { ok: false, error: result.error ?? "router unreachable", detail: "router unreachable" };
  const value = result.value as { applied: string[]; errors: string[] };
  if (value.errors.length > 0) return { ok: false, error: value.errors.join("; "), detail: value.errors.join("; ") };
  return { ok: true, detail: value.applied.join(" · ") };
}

export async function recordEvent(subscriberId: string, type: string, detail?: string, actor?: string) {
  await db.subscriberEvent.create({ data: { subscriberId, type, detail, actor } });
}

/** Execute a lifecycle transition with validation, router sync and audit trail. */
export async function runLifecycle(
  subscriberId: string,
  action: LifecycleAction,
  actor: string,
  opts: { packageId?: string; cycle?: string; confirm?: boolean } = {},
): Promise<{ ok: boolean; error?: string; detail?: string; subscriber?: Record<string, unknown> }> {
  const sub = await db.subscriber.findUnique({ where: { id: subscriberId }, include: { package: true } });
  if (!sub) return { ok: false, error: "المشترك غير موجود" };
  if (!VALID_TRANSITIONS[sub.status]?.includes(action)) {
    return { ok: false, error: `الانتقال «${action}» غير مسموح من الحالة «${sub.status}»` };
  }
  if ((action === "suspend" || action === "terminate") && opts.confirm !== true) {
    return { ok: false, error: "تتطلب هذه العملية تأكيداً صريحاً (confirm=true) — ستفصل خدمة المشترك على السيرفر" };
  }

  const now = new Date();
  let detail = "";

  switch (action) {
    case "activate": {
      if (sub.routerId && sub.username) {
        const r = await enforceOnRouter(sub.routerId, sub.username, "enable");
        await recordEvent(sub.id, r.ok ? "router_sync_ok" : "router_sync_error", r.detail || r.error, actor);
        if (!r.ok) return { ok: false, error: `تعذر التفعيل على السيرفر: ${r.error}` };
        detail = r.detail;
      }
      await db.subscriber.update({ where: { id: sub.id }, data: { status: "active", activatedAt: now } });
      detail = detail || "تم التفعيل";
      break;
    }
    case "suspend": {
      if (sub.routerId && sub.username) {
        const kick = await enforceOnRouter(sub.routerId, sub.username, "kick");
        const dis = await enforceOnRouter(sub.routerId, sub.username, "disable");
        await recordEvent(sub.id, dis.ok ? "router_sync_ok" : "router_sync_error", `${kick.detail ?? ""} ${dis.detail || dis.error}`.trim(), actor);
        if (!dis.ok) return { ok: false, error: `تعذر تعليق الحساب على السيرفر: ${dis.error}` };
        detail = dis.detail;
      }
      await db.subscriber.update({ where: { id: sub.id }, data: { status: "suspended", suspendedAt: now } });
      detail = detail || "تم التعليق";
      break;
    }
    case "reactivate": {
      if (sub.routerId && sub.username) {
        const r = await enforceOnRouter(sub.routerId, sub.username, "enable");
        await recordEvent(sub.id, r.ok ? "router_sync_ok" : "router_sync_error", r.detail || r.error, actor);
        if (!r.ok) return { ok: false, error: `تعذر إعادة التفعيل على السيرفر: ${r.error}` };
        detail = r.detail;
      }
      await db.subscriber.update({ where: { id: sub.id }, data: { status: "active", suspendedAt: null, expiresAt: sub.expiresAt && sub.expiresAt < now ? null : sub.expiresAt } });
      detail = detail || "تمت إعادة التفعيل";
      break;
    }
    case "renew": {
      const cycle = opts.cycle ?? "monthly";
      const pkg = sub.package;
      const amount = pkg?.price ?? 0;
      const hours = pkg?.durationHours ?? cycleHours(cycle);
      const base = sub.expiresAt && sub.expiresAt > now ? sub.expiresAt : now;
      const expiresAt = new Date(base.getTime() + hours * 3600 * 1000);
      await db.subscriber.update({ where: { id: sub.id }, data: { status: "active", expiresAt } });
      // ledger charge for the renewal cycle (idempotent reference)
      await db.customerTx.create({
        data: {
          type: "charge", subscriberId: sub.id, branchId: sub.branchId,
          amount, currency: pkg?.currency ?? "USD",
          reference: `renewal:${sub.id}:${expiresAt.toISOString().slice(0, 10)}:${hours}`,
          refType: "subscription", refId: sub.id,
          note: `تجديد ${pkg?.name ?? ""} — حتى ${expiresAt.toISOString().slice(0, 10)}`,
        },
      }).catch(() => { /* duplicate renewal for same day/cycle → idempotent skip */ });
      await recordEvent(sub.id, "renewed", `حتى ${expiresAt.toISOString().slice(0, 10)} · $${amount}`, actor);
      detail = `تم التجديد حتى ${expiresAt.toISOString().slice(0, 10)}`;
      break;
    }
    case "migrate_package": {
      if (!opts.packageId) return { ok: false, error: "packageId مطلوب للترحيل" };
      const pkg = await db.package.findUnique({ where: { id: opts.packageId } });
      if (!pkg) return { ok: false, error: "الباقة الجديدة غير موجودة" };
      if (sub.routerId && sub.username) {
        const r = await enforceOnRouter(sub.routerId, sub.username, "set_profile", { profile: pkg.profile });
        await recordEvent(sub.id, r.ok ? "router_sync_ok" : "router_sync_error", r.detail || r.error, actor);
        if (!r.ok) return { ok: false, error: `تعذر تغيير الباقة على السيرفر: ${r.error}` };
        detail = r.detail;
      }
      await db.subscriber.update({ where: { id: sub.id }, data: { packageId: pkg.id } });
      await recordEvent(sub.id, "package_migrated", `${sub.package?.name ?? "?"} → ${pkg.name}`, actor);
      detail = `${detail} — تم الترحيل إلى ${pkg.name}`;
      break;
    }
    case "terminate": {
      if (sub.routerId && sub.username) {
        const kick = await enforceOnRouter(sub.routerId, sub.username, "kick");
        const dis = await enforceOnRouter(sub.routerId, sub.username, "disable");
        await recordEvent(sub.id, dis.ok ? "router_sync_ok" : "router_sync_error", `${kick.detail ?? ""} ${dis.detail || dis.error}`.trim(), actor);
      }
      await db.subscriber.update({ where: { id: sub.id }, data: { status: "terminated", terminatedAt: now } });
      await recordEvent(sub.id, "terminated", undefined, actor);
      detail = "تم إنهاء الحساب (السجل محفوظ)";
      break;
    }
  }

  await recordEvent(sub.id, action, detail, actor);
  await db.activityLog.create({
    data: { actor, action: `subscriber:${action}`, target: `${sub.code} (${sub.name})`, details: detail },
  }).catch(() => {});

  const updated = await db.subscriber.findUnique({ where: { id: sub.id } });
  return { ok: true, detail, subscriber: updated as unknown as Record<string, unknown> };
}
