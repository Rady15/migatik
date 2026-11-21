import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { readHotspotLive } from "@/lib/hotspot-live";

/**
 * GET /api/hotspot/live?routerId=<id|all>
 *
 * Real-time Hotspot tables (Active / Hosts / Bindings) printed from the router
 * itself. Everything returned is currently connected — disconnected devices are
 * never included, which is exactly what the operator asked for.
 */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const ids = routerId && routerId !== "all" ? [routerId] : undefined;
    const data = await readHotspotLive(ids);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return serverError(e);
  }
});
