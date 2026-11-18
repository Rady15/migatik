import { NextRequest, NextResponse } from "next/server";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";
import { acknowledgeAlert } from "@/lib/alerts/engine";

/** PATCH /api/alerts/[id] — acknowledge alert. */
export const PATCH = withOrgStrict(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const acknowledge = body.acknowledge === true;

    if (!acknowledge) return badRequest("acknowledge must be true");

    await acknowledgeAlert(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});