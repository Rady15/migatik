import { PrismaClient } from "@prisma/client";
import { PLAN_PRICING, planAr, PERIOD_DAYS, GRACE_DAYS } from "@/lib/saas-plans";

/**
 * v4 Commercial SaaS — subscription lifecycle scheduler.
 * Runs every 10 minutes from src/instrumentation.ts (additive to the
 * discovery scheduler and the recurring-billing scheduler).
 *
 * Three idempotent lifecycle steps per tick:
 *  1. Trial expiry:  trialing + trialEndsAt < now        → past_due (+ warning notification)
 *  2. Grace:         past_due + currentPeriodEnd < now-7d → suspended + suspendedAt (+ danger notification)
 *  3. Renewal:       active + currentPeriodEnd < now     → advance period 30d + open OrgInvoice (+ info notification)
 *
 * Uses a dedicated raw PrismaClient (NOT the tenant-extended src/lib/db.ts):
 * the scheduler runs outside any request/tenant context and must reach every
 * organization, so all organizationId values are set explicitly below.
 * Every step is wrapped in try/catch — the scheduler never throws.
 */

const g = globalThis as unknown as {
  __mcm_saasPrisma?: PrismaClient;
  __mcm_saas_scheduler?: ReturnType<typeof setInterval>;
};

const DAY_MS = 24 * 3600 * 1000;

function client(): PrismaClient {
  if (!g.__mcm_saasPrisma) {
    g.__mcm_saasPrisma = new PrismaClient({ log: ["error", "warn"] });
  }
  return g.__mcm_saasPrisma;
}

/** Day-anchored period start → makes the invoice idempotency key stable across ticks. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function notify(prisma: PrismaClient, organizationId: string, title: string, body: string, severity: string): Promise<void> {
  try {
    await prisma.notification.create({
      data: { organizationId, title, body, type: "subscription", severity },
    });
  } catch (e) {
    console.error("[saas] notification create failed:", (e as Error).message);
  }
}

export async function runSaasSchedulerTick(): Promise<void> {
  const prisma = client();
  const now = new Date();
  const summary = { expiredTrials: 0, suspended: 0, renewed: 0 };
  try {
    // ---- 1) trial expiry: trialing + trialEndsAt < now → past_due ----
    const expiredTrials = await prisma.organization.findMany({
      where: { subscriptionStatus: "trialing", trialEndsAt: { lt: now } },
      select: { id: true, name: true },
    });
    for (const org of expiredTrials) {
      try {
        await prisma.organization.update({
          where: { id: org.id },
          data: { subscriptionStatus: "past_due" },
        });
        summary.expiredTrials++;
        await notify(
          prisma,
          org.id,
          "انتهت الفترة التجريبية",
          `انتهت الفترة التجريبية لمؤسستكم "${org.name}" — يرجى ترقية الخطة لتفادي التعليق`,
          "warning",
        );
      } catch (e) {
        console.error("[saas] trial expiry failed for org:", (e as Error).message);
      }
    }

    // ---- 2) grace: past_due + currentPeriodEnd < now - 7d → suspended ----
    const graceDeadline = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
    const overdue = await prisma.organization.findMany({
      where: { subscriptionStatus: "past_due", currentPeriodEnd: { lt: graceDeadline } },
      select: { id: true, name: true },
    });
    for (const org of overdue) {
      try {
        await prisma.organization.update({
          where: { id: org.id },
          data: {
            subscriptionStatus: "suspended",
            suspendedAt: now,
            suspensionReason: "انتهت مهلة السداد",
          },
        });
        summary.suspended++;
        await notify(
          prisma,
          org.id,
          "تم تعليق الاشتراك",
          `تم تعليق اشتراك مؤسستكم "${org.name}" بسبب عدم السداد — اتصلوا بمسؤول المنصة للتفعيل`,
          "danger",
        );
      } catch (e) {
        console.error("[saas] grace suspension failed for org:", (e as Error).message);
      }
    }

    // ---- 3) renewal: active + currentPeriodEnd < now → advance period + open invoice ----
    const dueRenewals = await prisma.organization.findMany({
      where: { subscriptionStatus: "active", currentPeriodEnd: { lt: now } },
      select: { id: true, name: true, plan: true },
    });
    for (const org of dueRenewals) {
      try {
        const periodStart = startOfDay(now); // day-anchored → stable idempotency key
        const periodEnd = new Date(periodStart.getTime() + PERIOD_DAYS * DAY_MS);
        const amount = PLAN_PRICING[org.plan];
        if (amount !== undefined) {
          // idempotent: skip if an invoice for this (org, plan, period start) already exists
          const existing = await prisma.orgInvoice.findFirst({
            where: { organizationId: org.id, plan: org.plan, periodStart },
            select: { id: true },
          });
          if (!existing) {
            await prisma.orgInvoice.create({
              data: {
                organizationId: org.id,
                plan: org.plan,
                amount,
                currency: "USD",
                periodStart,
                periodEnd,
                status: "open",
              },
            });
          }
        }
        await prisma.organization.update({
          where: { id: org.id },
          data: { currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + PERIOD_DAYS * DAY_MS) },
        });
        summary.renewed++;
        await notify(
          prisma,
          org.id,
          "تم تجديد الاشتراك",
          `تم تجديد اشتراك مؤسستكم "${org.name}" (خطة ${planAr(org.plan)}) لفترة جديدة — تم إصدار فاتورة مفتوحة حتى السداد`,
          "info",
        );
      } catch (e) {
        console.error("[saas] renewal failed for org:", (e as Error).message);
      }
    }

    if (summary.expiredTrials || summary.suspended || summary.renewed) {
      console.log("[saas] tick:", JSON.stringify(summary));
    }
  } catch (e) {
    console.error("[saas] scheduler tick error:", (e as Error).message);
  }
}

/** Start the 10-minute SaaS lifecycle loop once per process (double-registration guard). */
export function ensureSaasScheduler(): void {
  if (g.__mcm_saas_scheduler) return;
  console.log("[saas] subscription lifecycle scheduler started (every 10 min)");
  g.__mcm_saas_scheduler = setInterval(() => {
    runSaasSchedulerTick();
  }, 10 * 60_000);
  // don't keep the process alive just for the scheduler
  g.__mcm_saas_scheduler.unref?.();
}
