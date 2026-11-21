import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrgStrict } from "@/lib/tenancy";

/** withOrg forwards only (req, ctx); Next 16 delivers route params as a Promise.
 *  Read params off the request when available, else derive the trailing [id] from the URL. */
async function routeId(req: NextRequest): Promise<string> {
  const p = (req as NextRequest & { params?: Promise<{ id: string }> }).params;
  if (p) return (await p).id;
  return req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
}

export const PATCH = withOrgStrict(async (req: NextRequest) => {
  try {
    const id = await routeId(req);
    const b = await req.json();
    const data: Record<string, unknown> = {};
    if (b.status) data.status = String(b.status);
    if (b.notes !== undefined) data.notes = String(b.notes);
    if (b.dueDate !== undefined) data.dueDate = b.dueDate ? new Date(b.dueDate) : null;
    await db.invoice.update({ where: { id }, data });
    if (b.status === "paid") {
      await db.payment.create({
        data: {
          invoiceId: id,
          customerName: (await db.invoice.findUnique({ where: { id } }))?.customerName ?? null,
          amount: (await db.invoice.findUnique({ where: { id } }))?.total ?? 0,
          method: "manual",
          note: "دفعة فاتورة",
        },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx) => {
  try {
    const id = await routeId(req);
    const invoice = await db.invoice.findUnique({
      where: { id },
      select: { id: true, number: true, customerName: true, total: true, notes: true },
    });
    if (!invoice) return NextResponse.json({ error: "الفاتورة غير موجودة" }, { status: 404 });

    const payments = await db.payment.findMany({ where: { invoiceId: id }, select: { id: true, reference: true } });
    const paymentIds = payments.map((p) => p.id);

    // A voucher sale is a three-record trail (invoice + payment + ledger).
    // Find the card from the invoice notes / number / payment reference so all
    // three vanish together — otherwise the revenue KPI keeps the old money.
    const serials = new Set<string>();
    if (invoice.notes?.startsWith("voucher:")) serials.add(invoice.notes.slice(8));
    if (invoice.number.startsWith("VCH-")) serials.add(invoice.number.slice(4));
    for (const p of payments) if (p.reference?.startsWith("VCH-")) serials.add(p.reference.slice(4));
    const vouchers = serials.size
      ? await db.voucher.findMany({ where: { serial: { in: [...serials] } }, select: { id: true } })
      : [];
    const voucherIds = vouchers.map((v) => v.id);

    await db.customerTx.deleteMany({
      where: {
        OR: [
          { refType: "payment", refId: { in: paymentIds } },
          { refType: "voucher", refId: { in: voucherIds } },
        ],
      },
    });
    await db.refund.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await db.employeeCommission.deleteMany({ where: { refType: "payment", refId: { in: paymentIds } } });
    await db.payment.deleteMany({ where: { invoiceId: id } });
    await db.invoice.delete({ where: { id } });

    // Tombstone: the voucher usage scheduler must not re-create the sale.
    for (const v of vouchers) {
      await db.activityLog.create({
        data: { actor: ctx.username, action: "voucher_sale_deleted", target: v.id, details: invoice.number },
      });
    }
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "حذف فاتورة",
        target: invoice.number,
        details: `${invoice.customerName} — ${invoice.total}`,
      },
    });
    return NextResponse.json({ ok: true, paymentsDeleted: paymentIds.length, ledgerDeleted: paymentIds.length + voucherIds.length });
  } catch (e) {
    return serverError(e);
  }
});
