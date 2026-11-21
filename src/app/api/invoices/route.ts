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

/**
 * DELETE /api/invoices — clear the whole financial trail for the active org.
 * Removes invoices, payments, refunds, commissions and the CustomerTx ledger
 * so every money KPI goes back to zero. Voucher sales get a tombstone so the
 * usage scheduler cannot silently re-create them a minute later.
 */
export const DELETE = withOrgStrict(async (_req: NextRequest, ctx: OrgContext) => {
  try {
    const orgId = ctx.effectiveOrgId ?? ctx.org?.id;
    if (!orgId) return NextResponse.json({ error: "حدد المؤسسة أولاً" }, { status: 400 });
    const scope = { organizationId: orgId };

    const saleTxs = await db.customerTx.findMany({
      where: { ...scope, refType: "voucher" },
      select: { refId: true },
    });
    const voucherIds = [...new Set(saleTxs.map((t) => t.refId).filter(Boolean))] as string[];

    const [invoices, payments, txs, refunds, commissions] = await Promise.all([
      db.invoice.count({ where: scope }),
      db.payment.count({ where: scope }),
      db.customerTx.count({ where: scope }),
      db.refund.count({ where: scope }),
      db.employeeCommission.count({ where: scope }),
    ]);

    await db.refund.deleteMany({ where: scope });
    await db.employeeCommission.deleteMany({ where: scope });
    await db.customerTx.deleteMany({ where: scope });
    await db.payment.deleteMany({ where: scope });
    await db.invoice.deleteMany({ where: scope });

    for (const voucherId of voucherIds) {
      await db.activityLog.create({
        data: { actor: ctx.username, action: "voucher_sale_deleted", target: voucherId, details: "تصفية البيانات المالية" },
      });
    }
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "تصفية البيانات المالية",
        target: `${invoices} invoices`,
        details: `payments ${payments}, ledger ${txs}, refunds ${refunds}, commissions ${commissions}`,
      },
    });

    return NextResponse.json({ ok: true, deleted: { invoices, payments, txs, refunds, commissions }, vouchersVoided: voucherIds.length });
  } catch (e) {
    return serverError(e);
  }
});
