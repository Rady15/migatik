import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict } from "@/lib/tenancy";

export const GET = withOrg(async () => {
  try {
    const expenses = await db.expense.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return NextResponse.json({ expenses });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest) => {
  try {
    const b = await req.json();
    if (!b.description || !b.amount) return NextResponse.json({ error: "الوصف والمبلغ مطلوبان" }, { status: 400 });
    const expense = await db.expense.create({
      data: {
        category: b.category || "operational",
        description: String(b.description),
        amount: Number(b.amount),
      },
    });
    return NextResponse.json({ ok: true, expense });
  } catch (e) {
    return serverError(e);
  }
});
