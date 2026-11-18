import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { getAlerts } from "@/lib/alerts/engine";

/** GET /api/alerts — list alerts with filters. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const severity = req.nextUrl.searchParams.get("severity") ?? undefined;
    const entityType = req.nextUrl.searchParams.get("entityType") ?? undefined;
    const acknowledged = req.nextUrl.searchParams.get("acknowledged");
    const limit = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50));
    const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);

    const { alerts, total } = await getAlerts("unassigned", {
      severity,
      entityType,
      acknowledged: acknowledged === "1" ? true : acknowledged === "0" ? false : undefined,
      limit,
      offset,
    });

    return NextResponse.json({ alerts, total });
  } catch (e) {
    return serverError(e);
  }
});