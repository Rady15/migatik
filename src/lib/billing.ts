import { db } from "@/lib/db";
import { recordEvent } from "@/lib/subscribers";

/**
 * Recurring billing engine (v3).
 * - runBillingDue(): generates invoices + ledger charges for every due
 *   recurring subscription. Idempotent: the CustomerTx.reference unique key
 *   (`subscription:<id>:<periodStart>`) prevents duplicate financial records
 *   even if the runner fires twice.
 * - ensureBillingScheduler(): in-process tick every 60s (same model as the
 *   discovery scheduler in instrumentation).
 */

const CYCLE_MS: Record<string, number> = {
  daily: 24 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
  yearly: 365 * 24 * 3600 * 1000,
};

export function cycleLabelAr(cycle: string): string {
  return { daily: "يومي", weekly: "أسبوعي", monthly: "شهري", yearly: "سنوي" }[cycle] ?? cycle;
}

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await db.invoice.count();
  let n = count + 1;
  let number = `INV-${year}-${String(n).padStart(5, "0")}`;
  while (await db.invoice.findFirst({ where: { number } })) {
    n++;
    number = `INV-${year}-${String(n).padStart(5, "0")}`;
  }
  return number;
}

export interface BillingRunResult {
  processed: number;
  invoicesCreated: number;
  skipped: number;
  errors: { subscriptionId: string; error: string }[];
}

export async function runBillingDue(actor = "billing-engine"): Promise<BillingRunResult> {
  const now = new Date();
  const due = await db.recurringSubscription.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    include: { subscriber: true, package: true },
    take: 500,
  });
  const out: BillingRunResult = { processed: 0, invoicesCreated: 0, skipped: 0, errors: [] };

  for (const r of due) {
    out.processed++;
    try {
      const cycle = r.cycle;
      const periodStart = r.nextRunAt;
      const periodEnd = new Date(periodStart.getTime() + (CYCLE_MS[cycle] ?? CYCLE_MS.monthly));
      const gross = r.amount;
      const discount = Math.round(gross * (r.discountPct / 100) * 100) / 100;
      const net = gross - discount;
      const tax = Math.round(net * (r.taxRatePct / 100) * 100) / 100;
      const total = net + tax;

      if (r.autoInvoice) {
        const number = await nextInvoiceNumber();
        await db.invoice.create({
          data: {
            number,
            customerName: r.subscriber.name,
            description: `اشتراك ${cycleLabelAr(cycle)} — ${r.package?.name ?? ""} (${periodStart.toISOString().slice(0, 10)})`,
            amount: net,
            discount,
            taxRate: r.taxRatePct,
            taxAmount: tax,
            total,
            status: "unpaid",
            dueDate: periodEnd,
            branchId: r.subscriber.branchId,
            subscriberId: r.subscriber.id,
          },
        });
        out.invoicesCreated++;
      }

      // ledger charge — idempotent per period
      await db.customerTx.create({
        data: {
          type: "charge",
          subscriberId: r.subscriber.id,
          branchId: r.subscriber.branchId,
          amount: total,
          currency: r.currency,
          reference: `subscription:${r.id}:${periodStart.toISOString().slice(0, 10)}`,
          refType: "subscription",
          refId: r.id,
          note: `دورة ${cycleLabelAr(cycle)}`,
        },
      });

      // extend subscriber expiry by one cycle
      const sub = r.subscriber;
      const base = sub.expiresAt && sub.expiresAt > now ? sub.expiresAt : now;
      const expiresAt = new Date(base.getTime() + (CYCLE_MS[cycle] ?? CYCLE_MS.monthly));
      await db.subscriber.update({
        where: { id: sub.id },
        data: { expiresAt, status: sub.status === "registered" ? "active" : sub.status, activatedAt: sub.activatedAt ?? (sub.status === "registered" ? now : undefined) },
      });
      await recordEvent(sub.id, "renewed", `دورة ${cycleLabelAr(cycle)} — حتى ${expiresAt.toISOString().slice(0, 10)} ($${total})`, actor);

      await db.recurringSubscription.update({
        where: { id: r.id },
        data: { lastRunAt: now, nextRunAt: periodEnd },
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("Unique constraint")) out.skipped++; // already billed for this period
      else out.errors.push({ subscriptionId: r.id, error: msg });
    }
  }
  return out;
}

let billingTimer: ReturnType<typeof setInterval> | null = null;

/** In-process billing scheduler — one tick per minute. */
export function ensureBillingScheduler(): void {
  if (billingTimer) return;
  const g = globalThis as unknown as { __mcm_billing?: ReturnType<typeof setInterval> };
  if (g.__mcm_billing) { billingTimer = g.__mcm_billing; return; }
  billingTimer = setInterval(async () => {
    try {
      const res = await runBillingDue();
      if (res.invoicesCreated > 0) {
        await db.notification.create({
          data: {
            title: "دورة فوترة تلقائية",
            body: `تم إنشاء ${res.invoicesCreated} فاتورة اشتراك${res.errors.length ? ` — أخطاء: ${res.errors.length}` : ""}`,
            type: "financial",
            severity: res.errors.length ? "warning" : "success",
          },
        }).catch(() => {});
      }
    } catch { /* logged by caller contexts; never crash the scheduler */ }
  }, 60_000);
  g.__mcm_billing = billingTimer;
}
