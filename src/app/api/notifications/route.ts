import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict } from "@/lib/tenancy";

export const GET = withOrg(async () => {
  try {
    const notifications = await db.notification.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    const unread = notifications.filter((n) => !n.read).length;
    return NextResponse.json({ notifications, unread });
  } catch (e) {
    return serverError(e);
  }
});

export const PATCH = withOrgStrict(async (req: NextRequest) => {
  try {
    const b = await req.json();
    if (b.id) {
      await db.notification.update({ where: { id: b.id }, data: { read: true } });
    } else {
      await db.notification.updateMany({ data: { read: true } });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
