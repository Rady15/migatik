import { NextRequest, NextResponse } from "next/server";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";
import { runTrafficAggregation } from "@/lib/traffic/aggregation";

/** POST /api/traffic/aggregate — Manually trigger traffic aggregation for a day (defaults to yesterday). */
export const POST = withOrgStrict(async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    const day = body.day ?? undefined; // YYYY-MM-DD or undefined for yesterday

    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return badRequest("day يجب أن يكون بصيغة YYYY-MM-DD");
    }

    const result = await runTrafficAggregation(day);
    return NextResponse.json({ ok: true, day: day ?? "yesterday", ...result });
  } catch (e) {
    return serverError(e);
  }
});