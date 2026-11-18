/**
 * Next.js instrumentation hook — starts the background schedulers once per
 * server process (nodejs runtime only): discovery sync + SaaS subscription
 * lifecycle (trial expiry / grace suspension / renewal invoices).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureScheduler } = await import("@/lib/discovery/sync-engine");
  ensureScheduler();
  const { ensureSaasScheduler } = await import("@/lib/saas-scheduler");
  ensureSaasScheduler();
}
