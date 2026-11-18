import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";
import { runAlertChecks } from "@/lib/alerts/engine";

/** POST /api/alerts/check — manually run alert checks. */
export const POST = withOrgStrict(async (req: NextRequest) => {
  try {
    const result = await runAlertChecks();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return serverError(e);
  }
});