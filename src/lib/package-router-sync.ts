import { withRouterRow, type RouterLike } from "@/lib/router-transport";
import { runCommand, type RosConnection } from "@/lib/routeros";

/**
 * Write-through helper for /ip/hotspot/user/profile.
 * Packages are backed by real RouterOS hotspot profiles: every add/edit/delete
 * must be confirmed on the device before the local DB is changed.
 */

export interface ProfileWriteResult {
  ok: boolean;
  error?: string;
  rosId?: string;
  detail?: string;
  /** profile genuinely absent on the router (safe to treat as already deleted) */
  missing?: boolean;
}

function formatRate(mbps: number): string {
  const n = Number(mbps) || 0;
  if (n <= 0) return "0";
  if (n < 1) return `${Math.round(n * 1024)}k`;
  return `${Number(n.toFixed(3))}M`;
}

function rateLimit(down: number, up: number): string {
  return `${formatRate(down)}/${formatRate(up)}`;
}

async function findProfile(conn: RosConnection, name: string): Promise<Record<string, string> | null> {
  const list = await runCommand(conn, ["/ip/hotspot/user/profile/print"]);
  if (!list.ok) return null;
  const q = name.trim().toLowerCase();
  return list.data.find((r) => (r.name ?? "").trim().toLowerCase() === q) ?? null;
}

/**
 * Create or update the router profile. Name alone is the idempotency key:
 * if the profile already exists we update it rather than creating a duplicate.
 */
export async function upsertRouterProfile(
  router: RouterLike,
  opts: { currentName: string; desiredName: string; downMbps: number; upMbps: number },
): Promise<ProfileWriteResult> {
  const desired = opts.desiredName.trim();
  const current = (opts.currentName || desired).trim();
  if (!desired) return { ok: false, error: "اسم بروفايل الراوتر مطلوب" };

  const res = await withRouterRow(router, async (conn) => {
    const existing = (await findProfile(conn, desired)) ?? (current !== desired ? await findProfile(conn, current) : null);
    const rate = rateLimit(opts.downMbps, opts.upMbps);

    if (existing?.[".id"]) {
      const set = await runCommand(conn, [
        "/ip/hotspot/user/profile/set",
        `=.id=${existing[".id"]}`,
        `=name=${desired}`,
        `=rate-limit=${rate}`,
      ]);
      return {
        ok: set.ok,
        error: set.error,
        rosId: existing[".id"],
        detail: `updated ${desired} (${rate})`,
      } satisfies ProfileWriteResult;
    }

    const add = await runCommand(conn, [
      "/ip/hotspot/user/profile/add",
      `=name=${desired}`,
      `=rate-limit=${rate}`,
    ]);
    if (!add.ok) return { ok: false, error: add.error, detail: `add ${desired} (${rate})` } satisfies ProfileWriteResult;

    const created = await findProfile(conn, desired);
    return {
      ok: true,
      rosId: created?.[".id"],
      detail: `created ${desired} (${rate})`,
      error: created?.[".id"] ? undefined : "تم إنشاء البروفايل لكن تعذر التحقق من وجوده على الراوتر",
    } satisfies ProfileWriteResult;
  });

  if (!res.ok) return { ok: false, error: res.error ?? "تعذر الاتصال بالراوتر" };
  const value = res.value as ProfileWriteResult | undefined;
  if (!value) return { ok: false, error: "لم يتم إرجاع نتيجة من الراوتر" };
  if (!value.ok) return value;
  // A profile that was created but not re-found is not safe to record.
  if (value.error) return value;
  return value;
}

/** Remove a hotspot profile from the router. Absent = success (idempotent). */
export async function deleteRouterProfile(router: RouterLike, name: string): Promise<ProfileWriteResult> {
  const target = name.trim();
  if (!target) return { ok: false, error: "اسم البروفايل غير معروف" };
  const res = await withRouterRow(router, async (conn) => {
    const found = await findProfile(conn, target);
    if (!found) return { ok: true, missing: true, detail: `${target} غير موجود على الراوتر` } satisfies ProfileWriteResult;
    if (!found[".id"]) return { ok: false, error: "البروفايل موجود بلا معرف داخلي على الراوتر" } satisfies ProfileWriteResult;
    const del = await runCommand(conn, ["/ip/hotspot/user/profile/remove", `=.id=${found[".id"]}`]);
    return {
      ok: del.ok,
      error: del.error,
      rosId: found[".id"],
      detail: `removed ${target} (${found[".id"]})`,
    } satisfies ProfileWriteResult;
  });
  if (!res.ok) return { ok: false, error: res.error ?? "تعذر الاتصال بالراوتر" };
  return res.value ?? { ok: false, error: "لم يتم إرجاع نتيجة من الراوتر" };
}
