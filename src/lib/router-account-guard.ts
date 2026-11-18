/**
 * Shared guard for every "import accounts from RouterOS" job.
 *
 * Two classes of rows on the device must NEVER be imported into the app:
 *  - `default=true`  : built-in templates (e.g. `default-trial`) that RouterOS
 *                      refuses to delete; importing them creates ghost users.
 *  - `dynamic=true`  : auto-created by active hotspot logins (MAC cookies);
 *                      they disappear by themselves and are read-only.
 *
 * Used by hotspot-user-sync, subscriber-sync and any future importer so the
 * rule is defined once instead of drifting between modules.
 */
export function isDeviceManagedRow(row: Record<string, string>): boolean {
  return row.default === "true" || row.dynamic === "true";
}

/** Setting key that lets the operator switch automatic account import off. */
export const AUTO_IMPORT_SETTING = "auto_import_router_accounts";

/** Setting values are strings ("0"/"1"); missing means enabled (legacy behaviour). */
export function autoImportEnabled(value?: string | null): boolean {
  return value !== "0" && value !== "false";
}
