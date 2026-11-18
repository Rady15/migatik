import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    const invoices = await db.invoice.findMany({
      where: routerId && routerId !== "all" ? { subscriber: { routerId } } : {},
      orderBy: { createdAt: "desc" },
      include: { payments: { select: { amount: true } } },
    });
    return NextResponse.json({ invoices });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.customerName || !b.amount) return NextResponse.json({ error: "اسم العميل والمبلغ مطلوبان" }, { status: 400 });
    const count = await db.invoice.count();
    const amount = Number(b.amount);
    const discount = Number(b.discount) || 0;
    const taxRate = Number(b.taxRate) || 0;
    const taxAmount = Math.round(((amount - discount) * taxRate / 100) * 100) / 100;
    const invoice = await db.invoice.create({
      data: {
        number: `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`,
        customerName: String(b.customerName),
        customerPhone: b.customerPhone ? String(b.customerPhone) : null,
        description: b.description ? String(b.description) : null,
        amount, discount, taxRate, taxAmount,
        total: Math.round((amount - discount + taxAmount) * 100) / 100,
        status: b.status === "paid" ? "paid" : "unpaid",
        dueDate: b.dueDate ? new Date(b.dueDate) : null,
        notes: b.notes ? String(b.notes) : null,
      },
    });
    await db.activityLog.create({ data: { actor: ctx.username, action: "إنشاء فاتورة", target: invoice.number } });
    return NextResponse.json({ ok: true, invoice });
  } catch (e) {
    return serverError(e);
  }
});
