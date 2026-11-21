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
    const invoice = await db.invoice.findUnique({ where: { id }, select: { number: true, customerName: true, total: true } });
    if (!invoice) return NextResponse.json({ error: "الفاتورة غير موجودة" }, { status: 404 });
    // Keep the money: a paid invoice's payment stays in the ledger as revenue,
    // it just loses the link to the deleted document.
    await db.payment.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } });
    await db.invoice.delete({ where: { id } });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "حذف فاتورة",
        target: invoice.number,
        details: `${invoice.customerName} — ${invoice.total}`,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
