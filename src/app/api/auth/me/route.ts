import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";

export async function GET(req?: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });
  const org = session.organizationId
    ? await db.organization.findUnique({ where: { id: session.organizationId } })
    : null;
  return NextResponse.json({
    user: { id: session.uid, name: session.name, role: session.role },
    isPlatform: !session.organizationId && session.role === "SUPER_ADMIN",
    org: org
      ? {
          id: org.id,
          code: org.code,
          name: org.name,
          plan: org.plan,
          subscriptionStatus: org.subscriptionStatus,
          brandName: org.brandName,
          brandPrimary: org.brandPrimary,
          logoUrl: org.logoUrl,
          maxRouters: org.maxRouters,
          maxUsers: org.maxUsers,
          maxVouchersPerBatch: org.maxVouchersPerBatch,
          trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
          currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
        }
      : null,
  });
}
