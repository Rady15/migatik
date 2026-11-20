import { db } from "@/lib/db";

/**
 * Voucher → money.
 *
 * A prepaid hotspot card is inventory until the customer uses it. The first
 * real usage (or an explicit "sold" action) is the moment the sale happens, so
 * this helper records the complete financial trail exactly once per card:
 *
 *   Invoice (paid)  ← what the invoices page shows
 *   Payment (cash)  ← what the payments page shows
 *   CustomerTx      ← what the finance dashboard/revenue/net-profit sums
 *                     (type "voucher_sale", reference "voucher:<id>" = unique)
 *
 * Idempotent: the CustomerTx reference is unique at DB level, so calling this
 * again (re-open dashboard, another scheduler tick, manual resync) can never
 * double-count revenue. Cards priced at 0 are skipped (free/trial cards).
 */

const referenceOf = (voucherId: string) => `voucher:${voucherId}`;

export interface VoucherSaleResult {
  ok: boolean;
  created: boolean;
  invoiceId?: string;
  error?: string;
}

export async function ensureVoucherSale(voucherId: string): Promise<VoucherSaleResult> {
  const v = await db.voucher.findUnique({
    where: { id: voucherId },
    include: {
      package: { select: { name: true } },
      router: { select: { name: true } },
    },
  });
  if (!v) return { ok: false, created: false, error: "الكرت غير موجود" };

  const price = Math.round((Number(v.price) || 0) * 100) / 100;
  if (price <= 0) return { ok: true, created: false }; // free card — nothing to bill

  const reference = referenceOf(v.id);
  const existing = await db.customerTx.findUnique({ where: { reference } });
  if (existing) return { ok: true, created: false, invoiceId: existing.refId ?? undefined };

  const currency = v.currency || "USD";
  const pkgName = v.package?.name ? ` «${v.package.name}»` : "";
  const routerName = v.router?.name ? ` — ${v.router.name}` : "";
  const customerName = `كارت هوت سبوت ${v.username}`;

  // 1) Invoice — number derived from the card serial keeps it unique per org.
  const number = `VCH-${v.serial}`;
  let invoice = await db.invoice.findFirst({ where: { number } });
  if (!invoice) {
    invoice = await db.invoice
      .create({
        data: {
          organizationId: v.organizationId,
          number,
          customerName,
          description: `بيع كارت${pkgName} — ${v.username}${routerName}`,
          amount: price,
          discount: 0,
          taxRate: 0,
          taxAmount: 0,
          total: price,
          status: "paid",
          dueDate: new Date(),
          notes: `voucher:${v.serial}`,
        },
      })
      .catch(async (e) => {
        // concurrent creation won the race — reuse that invoice
        const found = await db.invoice.findFirst({ where: { number } }).catch(() => null);
        if (found) return found;
        throw e;
      });
  }

  // 2) Payment (cash) — linked to the invoice so the invoice is genuinely paid.
  const alreadyPaid = await db.payment.findFirst({ where: { invoiceId: invoice.id } });
  if (!alreadyPaid) {
    await db.payment
      .create({
        data: {
          organizationId: v.organizationId,
          invoiceId: invoice.id,
          customerName,
          amount: price,
          currency,
          method: "cash",
          reference: `VCH-${v.serial}`,
          note: `بيع كارت هوت سبوت — ${v.username}`,
          receivedBy: "auto",
        },
      })
      .catch(() => {});
  }

  // 3) Unified ledger — revenue & net profit on the finance dashboard.
  await db.customerTx
    .create({
      data: {
        organizationId: v.organizationId,
        type: "voucher_sale",
        amount: price,
        currency,
        method: "cash",
        reference,
        refType: "voucher",
        refId: v.id,
        note: `بيع كارت ${v.username}${pkgName}`,
        employeeName: "auto",
      },
    })
    .catch((e) => {
      // Unique reference → another call already recorded this sale.
      if ((e as { code?: string }).code === "P2002") return;
      throw e;
    });

  return { ok: true, created: true, invoiceId: invoice.id };
}

/** Backfill: record sales for cards already used before this logic existed. */
export async function backfillVoucherSales(): Promise<{ scanned: number; created: number; errors: number }> {
  const vouchers = await db.voucher.findMany({
    where: { status: { in: ["activated", "sold"] }, price: { gt: 0 } },
    select: { id: true },
  });
  let created = 0;
  let errors = 0;
  for (const v of vouchers) {
    try {
      const res = await ensureVoucherSale(v.id);
      if (res.created) created++;
    } catch {
      errors++;
    }
  }
  return { scanned: vouchers.length, created, errors };
}
