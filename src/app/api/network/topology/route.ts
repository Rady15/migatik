import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-auth";
import { withOrg } from "@/lib/tenancy";
import { buildMultiRouterTopology, saveTopologySnapshot, getTopologySnapshots, getTopologySnapshot } from "@/lib/discovery/topology";

/** GET /api/network/topology — interactive map built from real RouterOS observations. */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const snapshotId = req.nextUrl.searchParams.get("snapshotId");
    const history = req.nextUrl.searchParams.get("history");
    const save = req.nextUrl.searchParams.get("save");

    // Historical playback
    if (snapshotId) {
      const snapshot = await getTopologySnapshot(snapshotId);
      if (!snapshot) return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
      return NextResponse.json(snapshot.snapshot);
    }

    // History list
    if (history && routerId && routerId !== "all") {
      const snapshots = await getTopologySnapshots(routerId, 50);
      return NextResponse.json({ snapshots });
    }

    // Handle "all" as undefined (no filter)
    const effectiveRouterId = routerId && routerId !== "all" ? routerId : undefined;
    const t = await buildMultiRouterTopology(effectiveRouterId);

    // Save snapshot if requested
    if (save && effectiveRouterId) {
      await saveTopologySnapshot(effectiveRouterId, t);
    }

    return NextResponse.json(t);
  } catch (e) {
    return serverError(e);
  }
});
