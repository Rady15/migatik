import { runCommand, type RosConnection } from "@/lib/routeros";
import { voucherCredential } from "@/lib/voucher-auth";

/**
 * RouterOS-side operations for existing vouchers.
 * Voucher cards already create real hotspot users at generation time; these
 * helpers let later actions (sell / activate / resync / expire / delete) keep
 * the device in sync instead of only changing local status fields.
 */

export interface VoucherRouterLimits {
  limitUptime?: string;
  limitBytesTotal?: number;
}

/** RouterOS time format: 720h → 30d, 168h → 1w, 24h → 1d. */
export function formatLimitUptime(hours?: number | null): string | undefined {
  const h = Number(hours ?? 0);
  if (!Number.isFinite(h) || h <= 0) return undefined;
  if (h % 168 === 0) return `${h / 168}w`;
  if (h % 24 === 0) return `${h / 24}d`;
  return `${h}h`;
}

export interface RouterVoucher {
  id: string;
  username: string;
  password?: string | null;
  passwordEnc?: string | null;
  authMode: string;
}

function credentialOf(v: RouterVoucher): string {
  if (v.authMode === "pin") return v.username;
  if (v.authMode === "username_only") return "";
  return voucherCredential(v);
}

function findUser(conn: RosConnection, username: string) {
  // Print all + filter locally: proven pattern for the `.id` attribute.
  return runCommand(conn, ["/ip/hotspot/user/print"]).then((list) => ({
    ok: list.ok,
    error: list.error,
    row: list.ok ? list.data.find((r) => (r.name ?? "").toLowerCase() === username.toLowerCase()) : undefined,
  }));
}

/** Create the router user if missing, or repair its password/profile/disabled state. */
export async function upsertVoucherUser(
  conn: RosConnection,
  voucher: RouterVoucher,
  profile: string,
  disabled = false,
  limits?: VoucherRouterLimits,
): Promise<{ ok: boolean; error?: string; mode?: "created" | "updated" }> {
  const password = credentialOf(voucher);
  const limitWords = [
    ...(limits?.limitUptime ? [`=limit-uptime=${limits.limitUptime}`] : []),
    ...(limits?.limitBytesTotal && limits.limitBytesTotal > 0 ? [`=limit-bytes-total=${Math.floor(limits.limitBytesTotal)}`] : []),
  ];
  const found = await findUser(conn, voucher.username);
  if (!found.ok) return { ok: false, error: found.error ?? "تعذر قراءة مستخدمي الراوتر" };

  const disabledValue = disabled ? "yes" : "no";
  if (found.row?.[".id"]) {
    const set = await runCommand(conn, [
      "/ip/hotspot/user/set",
      `=.id=${found.row[".id"]}`,
      `=password=${password}`,
      `=profile=${profile}`,
      `=disabled=${disabledValue}`,
      ...limitWords,
    ]);
    return { ok: set.ok, error: set.error, mode: "updated" };
  }

  const add = await runCommand(conn, [
    "/ip/hotspot/user/add",
    `=name=${voucher.username}`,
    `=password=${password}`,
    `=profile=${profile}`,
    `=disabled=${disabledValue}`,
    `=comment=voucher:${voucher.id}`,
    ...limitWords,
  ]);
  return { ok: add.ok, error: add.error, mode: "created" };
}

/** Disable/enable without deleting — used by expire/reactivate. */
export async function setVoucherUserDisabled(
  conn: RosConnection,
  username: string,
  disabled: boolean,
): Promise<{ ok: boolean; error?: string; missing?: boolean }> {
  const found = await findUser(conn, username);
  if (!found.ok) return { ok: false, error: found.error ?? "تعذر قراءة مستخدمي الراوتر" };
  if (!found.row?.[".id"]) return { ok: true, missing: true };
  const set = await runCommand(conn, [
    "/ip/hotspot/user/set",
    `=.id=${found.row[".id"]}`,
    `=disabled=${disabled ? "yes" : "no"}`,
  ]);
  return { ok: set.ok, error: set.error };
}

/** Remove the hotspot user from the router before deleting its DB record. */
export async function removeVoucherUser(
  conn: RosConnection,
  username: string,
): Promise<{ ok: boolean; error?: string; removed?: boolean; missing?: boolean }> {
  const found = await findUser(conn, username);
  if (!found.ok) return { ok: false, error: found.error ?? "تعذر قراءة مستخدمي الراوتر" };
  if (!found.row?.[".id"]) return { ok: true, removed: false, missing: true };
  const del = await runCommand(conn, ["/ip/hotspot/user/remove", `=.id=${found.row[".id"]}`]);
  return { ok: del.ok, error: del.error, removed: del.ok };
}
