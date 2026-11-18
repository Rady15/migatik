import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { readLiveMonitoring } from "@/lib/live-monitoring";

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const live = await readLiveMonitoring(routerId && routerId !== "all" ? [routerId] : undefined);
    return NextResponse.json({
      sessions: live.sessions.map((s) => ({
        id: s.id,
        username: s.username,
        ip: s.ip,
        mac: s.mac,
        routerName: s.routerName,
        startedAt: s.startedAt,
        durationSec: s.durationSec,
        uploadMb: s.uploadMb,
        downloadMb: s.downloadMb,
        speed: s.speed,
      })),
      errors: live.errors,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return serverError(e);
  }
});
