import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped tenant context (AsyncLocalStorage).
 * src/lib/db.ts reads this store and injects organizationId into EVERY
 * Prisma operation on tenant-owned models — defense in depth under the
 * per-route filters. Verified by scripts/cross-tenant-pentest.ts.
 */
export interface TenantCtx {
  organizationId: string;
  isPlatform: boolean;
}

// IMPORTANT: Next.js bundles server code per route — module-level singletons get
// duplicated across route bundles, while the Prisma client cached on globalThis
// keeps ONE closure. Store the ALS instance itself on globalThis so every bundle
// copy reads/writes the SAME storage. (Verified by scripts/cross-tenant-pentest.ts)
const g = globalThis as unknown as { __mtcmTenantStorage?: AsyncLocalStorage<TenantCtx> };
const storage = g.__mtcmTenantStorage ?? (g.__mtcmTenantStorage = new AsyncLocalStorage<TenantCtx>());

export function runWithTenant<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getTenantCtx(): TenantCtx | null {
  return storage.getStore() ?? null;
}

/**
 * Every Prisma model that carries organizationId and MUST be tenant-isolated.
 * Kept in sync with prisma/schema.prisma (v4). `Setting` is intentionally global.
 */
export const TENANT_MODELS = new Set<string>([
  "AdminUser",
  "Router",
  "RouterEnrollment",
  "RouterMetric",
  "Package",
  "HotspotUser",
  "HotspotSession",
  "Customer",
  "VoucherBatch",
  "Voucher",
  "Invoice",
  "Payment",
  "Expense",
  "Notification",
  "ActivityLog",
  "SupportTicket",
  "NetworkDevice",
  "DeviceObservation",
  "DeviceEvent",
  "DeviceIpHistory",
  "DeviceMacHistory",
  "DeviceTrafficSample",
  "DeviceTrafficDaily",
  "DeviceStatsSnapshot",
  "DhcpLease",
  "ArpEntry",
  "BridgeHost",
  "WirelessClient",
  "PppSession",
  "NetworkResource",
  "DiscoveryJob",
  "DiscoveryJobLog",
  "DeviceBlockRule",
  "Branch",
  "Subscriber",
  "SubscriberEvent",
  "RecurringSubscription",
  "CustomerTx",
  "Refund",
  "CashRegister",
  "DailyClosing",
  "EmployeeCommission",
  "NetworkAgent",
  "AgentCommand",
  "OrgInvoice",
  "UsageCounter",
]);
