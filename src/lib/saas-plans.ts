/**
 * v4 Commercial SaaS — plan catalog shared by the platform operator console
 * (src/app/api/platform/orgs), the org API (src/app/api/org) and the
 * subscription lifecycle scheduler (src/lib/saas-scheduler.ts).
 */

export interface PlanLimits {
  maxRouters: number;
  maxUsers: number;
  maxVouchersPerBatch: number;
}

/** Hard limits derived from the plan (re-applied on every plan change). */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  trial: { maxRouters: 3, maxUsers: 5, maxVouchersPerBatch: 250 },
  starter: { maxRouters: 10, maxUsers: 10, maxVouchersPerBatch: 1000 },
  pro: { maxRouters: 50, maxUsers: 25, maxVouchersPerBatch: 5000 },
  enterprise: { maxRouters: 1000, maxUsers: 100, maxVouchersPerBatch: 50000 },
};

/** Monthly platform subscription price (USD) — used for renewal invoices. */
export const PLAN_PRICING: Record<string, number> = {
  starter: 29,
  pro: 79,
  enterprise: 199,
};

export const PLANS = Object.keys(PLAN_LIMITS);

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "suspended", "canceled"] as const;

export const TRIAL_DAYS = 14;
export const PERIOD_DAYS = 30;
export const GRACE_DAYS = 7;

export function limitsFor(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.trial;
}

export function planAr(plan: string): string {
  return ({ trial: "تجريبي", starter: "Starter", pro: "Pro", enterprise: "Enterprise" } as Record<string, string>)[plan] ?? plan;
}

export function statusAr(status: string): string {
  return (
    ({ trialing: "تجريبي", active: "نشط", past_due: "متأخر", suspended: "معلق", canceled: "ملغي" } as Record<string, string>)[status] ?? status
  );
}
