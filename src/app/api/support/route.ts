import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";

export const GET = withOrg(async () => {
  try {
    const tickets = await db.supportTicket.findMany({ orderBy: { createdAt: "desc" } });
    const activity = await db.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return NextResponse.json({ tickets, activity });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.subject || !b.message) return NextResponse.json({ error: "الموضوع والرسالة مطلوبان" }, { status: 400 });
    const ticket = await db.supportTicket.create({
      data: {
        subject: String(b.subject),
        message: String(b.message),
        requester: ctx.username,
        priority: ["low", "medium", "high"].includes(b.priority) ? b.priority : "medium",
      },
    });
    return NextResponse.json({ ok: true, ticket });
  } catch (e) {
    return serverError(e);
  }
});

export const PATCH = withOrgStrict(async (req: NextRequest) => {
  try {
    const b = await req.json();
    if (!b.id) return NextResponse.json({ error: "معرّف مطلوب" }, { status: 400 });
    await db.supportTicket.update({
      where: { id: String(b.id) },
      data: { status: String(b.status || "open") },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
