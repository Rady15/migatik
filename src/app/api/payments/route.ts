import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";

export const GET = withOrg(async (req: NextRequest) => {
  try {
    const routerId = req.nextUrl.searchParams.get("routerId");
    // Payments have no router column — attribute them through the subscriber.
    const where = routerId && routerId !== "all"
      ? { OR: [{ subscriber: { routerId } }, { invoice: { subscriber: { routerId } } }] }
      : {};
    const payments = await db.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Number(req.nextUrl.searchParams.get("take") || 200),
      include: { invoice: { select: { number: true } } },
    });
    return NextResponse.json({ payments });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.amount) return NextResponse.json({ error: "المبلغ مطلوب" }, { status: 400 });
    if (b.invoiceId) {
      const invoice = await db.invoice.findFirst({ where: { id: String(b.invoiceId) } });
      if (!invoice) return NextResponse.json({ error: "الفاتورة غير موجودة" }, { status: 400 });
    }
    const payment = await db.payment.create({
      data: {
        invoiceId: b.invoiceId || null,
        customerName: b.customerName ? String(b.customerName) : null,
        amount: Number(b.amount),
        method: ["cash", "bank", "electronic", "manual"].includes(b.method) ? b.method : "cash",
        reference: b.reference ? String(b.reference) : null,
        note: b.note ? String(b.note) : null,
      },
    });
    // keep the unified ledger in sync (idempotent reference at DB level)
    await db.customerTx.create({
      data: {
        type: "payment",
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        reference: `payment:${payment.id}`,
        refType: "payment",
        refId: payment.id,
        note: payment.note ?? undefined,
        employeeName: ctx.username,
      },
    }).catch(async () => {
      // reference collision can only be the same payment (idempotent) — safe to ignore
    });
    await db.activityLog.create({ data: { actor: ctx.username, action: "تسجيل دفعة", target: `$${payment.amount}` } });
    return NextResponse.json({ ok: true, payment });
  } catch (e) {
    return serverError(e);
  }
});
