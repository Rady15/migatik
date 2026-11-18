import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { runBillingDue, ensureBillingScheduler } from "@/lib/billing";

ensureBillingScheduler(); // idempotent — keeps recurring billing alive in dev hot reload too

/**
 * Consolidated ISP accounting API (v3/v4).
 * GET  ?view=summary|tx|pl|closings|registers|subscriptions
 * POST { action: payment|refund|adjustment|discount|register_open|register_close|closing_run|subscription_create|subscription_update|billing_run }
 *
 * Every financial movement goes through the CustomerTx ledger; `reference` is a
 * UNIQUE idempotency key at DB level — duplicate financial records are impossible.
 */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view") ?? "summary";
    const branchId = sp.get("branchId") && sp.get("branchId") !== "all" ? sp.get("branchId")! : null;
    const days = Math.min(365, Math.max(1, Number(sp.get("days") || 30)));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const branchWhere = branchId ? { branchId } : {};
    const routerId = sp.get("routerId") && sp.get("routerId") !== "all" ? sp.get("routerId")! : null;
    // CustomerTx / Invoice have no router column — attribute them through the subscriber.
    const routerWhere = routerId ? { subscriber: { routerId } } : {};

    if (view === "summary") {
      const [revenue, refunds, expenses, commissions, txCount, unpaidInvoices] = await Promise.all([
        db.customerTx.aggregate({ where: { ...branchWhere, ...routerWhere, type: { in: ["payment", "voucher_sale"] }, createdAt: { gte: since } }, _sum: { amount: true } }),
        db.customerTx.aggregate({ where: { ...branchWhere, ...routerWhere, type: "refund", createdAt: { gte: since } }, _sum: { amount: true } }),
        db.customerTx.aggregate({ where: { ...branchWhere, ...routerWhere, type: "expense", createdAt: { gte: since } }, _sum: { amount: true } }),
        db.customerTx.aggregate({ where: { ...branchWhere, ...routerWhere, type: "commission", createdAt: { gte: since } }, _sum: { amount: true } }),
        db.customerTx.count({ where: { ...branchWhere, ...routerWhere, createdAt: { gte: since } } }),
        db.invoice.aggregate({ where: { ...branchWhere, ...routerWhere, status: { in: ["unpaid", "partial", "overdue"] } }, _sum: { total: true } }),
      ]);
      const revenue_ = revenue._sum.amount ?? 0;
      const refunds_ = Math.abs(refunds._sum.amount ?? 0);
      const expenses_ = Math.abs(expenses._sum.amount ?? 0);
      const commissions_ = Math.abs(commissions._sum.amount ?? 0);
      return NextResponse.json({
        days,
        revenue: revenue_,
        refunds: refunds_,
        expenses: expenses_,
        commissions: commissions_,
        netProfit: revenue_ - refunds_ - expenses_ - commissions_,
        txCount,
        outstanding: unpaidInvoices._sum.total ?? 0,
      });
    }

    if (view === "tx") {
      const txs = await db.customerTx.findMany({
        where: { ...branchWhere, ...routerWhere, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" }, take: 300,
        include: { subscriber: { select: { code: true, name: true } }, branch: { select: { name: true } } },
      });
      return NextResponse.json({ txs });
    }

    if (view === "pl") {
      // profit & loss grouped by day (SQLite-safe via JS grouping over tx rows)
      const [charges, refunds, expenses, commissions] = await Promise.all([
        db.customerTx.findMany({ where: { ...branchWhere, ...routerWhere, type: { in: ["payment", "voucher_sale", "charge"] }, createdAt: { gte: since } }, select: { amount: true, createdAt: true, type: true } }),
        db.customerTx.findMany({ where: { ...branchWhere, ...routerWhere, type: "refund", createdAt: { gte: since } }, select: { amount: true, createdAt: true } }),
        db.customerTx.findMany({ where: { ...branchWhere, ...routerWhere, type: "expense", createdAt: { gte: since } }, select: { amount: true, createdAt: true } }),
        db.customerTx.findMany({ where: { ...branchWhere, ...routerWhere, type: "commission", createdAt: { gte: since } }, select: { amount: true, createdAt: true } }),
      ]);
      const byDay = new Map<string, { day: string; revenue: number; refunds: number; expenses: number; commissions: number; net: number }>();
      const dayOf = (d: Date) => d.toISOString().slice(0, 10);
      const ensure = (day: string) => byDay.get(day) ?? byDay.set(day, { day, revenue: 0, refunds: 0, expenses: 0, commissions: 0, net: 0 }).get(day)!;
      for (const c of charges) { const r = ensure(dayOf(c.createdAt)); r.revenue += c.amount; }
      for (const c of refunds) { const r = ensure(dayOf(c.createdAt)); r.refunds += Math.abs(c.amount); }
      for (const c of expenses) { const r = ensure(dayOf(c.createdAt)); r.expenses += Math.abs(c.amount); }
      for (const c of commissions) { const r = ensure(dayOf(c.createdAt)); r.commissions += Math.abs(c.amount); }
      const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((r) => ({ ...r, net: r.revenue - r.refunds - r.expenses - r.commissions }));
      // per-branch breakdown for the period
      const branchRows = await db.customerTx.groupBy({
        by: ["branchId", "type"],
        where: { ...routerWhere, createdAt: { gte: since }, branchId: branchId ? branchId : undefined, type: { in: ["payment", "voucher_sale", "refund", "expense", "commission"] } },
        _sum: { amount: true },
      });
      return NextResponse.json({ daily: rows, byBranch: branchRows.map((b) => ({ branchId: b.branchId, type: b.type, amount: b._sum.amount ?? 0 })) });
    }

    if (view === "closings") {
      const closings = await db.dailyClosing.findMany({
        where: branchWhere, orderBy: { day: "desc" }, take: 60,
        include: { branch: { select: { name: true } } },
      });
      return NextResponse.json({ closings });
    }

    if (view === "registers") {
      const registers = await db.cashRegister.findMany({
        where: branchWhere, orderBy: { createdAt: "asc" },
        include: { branch: { select: { name: true } } },
      });
      return NextResponse.json({ registers });
    }

    if (view === "subscriptions") {
      const subs = await db.recurringSubscription.findMany({
        where: routerId
          ? { routerId }
          : branchId ? { subscriber: { branchId } } : {},
        orderBy: { nextRunAt: "asc" }, take: 300,
        include: { subscriber: { select: { code: true, name: true, status: true } }, package: { select: { name: true, price: true } } },
      });
      return NextResponse.json({ subscriptions: subs });
    }

    return badRequest(`view غير معروف: ${view}`);
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext) => {
  try {
    const b = await req.json();
    const action = String(b.action ?? "");
    const branchId = b.branchId || null;

    switch (action) {
      case "payment": {
        const amount = Number(b.amount);
        if (!amount || amount <= 0) return badRequest("المبلغ مطلوب ويجب أن يكون موجباً");
        const reference = b.reference ? String(b.reference) : `payment:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
        // idempotency at the ledger level — duplicate references are rejected
        if (await db.customerTx.findUnique({ where: { reference } })) {
          return badRequest("سجل مالي بنفس المرجع موجود مسبقاً — منع التكرار (idempotency)");
        }
        const payment = await db.payment.create({
          data: {
            invoiceId: b.invoiceId || null,
            customerName: b.customerName ? String(b.customerName) : null,
            subscriberId: b.subscriberId || null,
            amount, currency: String(b.currency || "USD"),
            method: ["cash", "bank", "electronic", "manual"].includes(b.method) ? b.method : "cash",
            reference, note: b.note ? String(b.note) : null,
            branchId, registerId: b.registerId || null, receivedBy: ctx.username,
          },
        });
        // partial-payment status update on the linked invoice (ownership-checked)
        if (b.invoiceId) {
          const invoice = await db.invoice.findFirst({ where: { id: String(b.invoiceId) }, include: { payments: true } });
          if (invoice) {
            const paid = invoice.payments.reduce((a, p) => a + p.amount, 0);
            const status = paid >= invoice.total - 1e-9 ? "paid" : paid > 0 ? "partial" : "unpaid";
            await db.invoice.update({ where: { id: invoice.id }, data: { status } });
          }
        }
        await db.customerTx.create({
          data: {
            type: "payment", subscriberId: b.subscriberId || null, branchId,
            amount, currency: String(b.currency || "USD"), method: payment.method,
            reference, refType: "payment", refId: payment.id,
            note: b.note ? String(b.note) : null, registerId: b.registerId || null, employeeName: ctx.username,
          },
        });
        // employee commission (configurable percent in settings, default 0)
        const setting = await db.setting.findUnique({ where: { key: "commission_pct" } });
        const pct = setting ? Number(setting.value) || 0 : 0;
        if (pct > 0) {
          const commission = Math.round(amount * (pct / 100) * 100) / 100;
          await db.employeeCommission.create({
            data: { employeeName: ctx.username, branchId, refType: "payment", refId: payment.id, rate: pct, amount: commission },
          });
          await db.customerTx.create({
            data: { type: "commission", branchId, amount: -commission, reference: `commission:${payment.id}`, refType: "payment", refId: payment.id, note: `عمولة ${pct}% — ${ctx.username}`, employeeName: ctx.username },
          });
        }
        await db.activityLog.create({ data: { actor: ctx.username, action: "finance:payment", target: `$${amount}`, details: reference } });
        return NextResponse.json({ ok: true, payment, reference });
      }

      case "refund": {
        const paymentId = String(b.paymentId ?? "");
        const amount = Number(b.amount);
        if (!paymentId || !amount || amount <= 0) return badRequest("paymentId والمبلغ مطلوبان");
        const payment = await db.payment.findUnique({ where: { id: paymentId } });
        if (!payment) return badRequest("الدفعة غير موجودة");
        const refunded = await db.refund.aggregate({ where: { paymentId }, _sum: { amount: true } });
        const already = refunded._sum.amount ?? 0;
        if (already + amount > payment.amount + 1e-9) return badRequest(`مجموع المرتجعات (${already}) + المبلغ المطلوب يتجاوز قيمة الدفعة (${payment.amount})`);
        const reference = `refund:${paymentId}:${Date.now()}`;
        const refund = await db.refund.create({ data: { paymentId, amount, reason: b.reason ? String(b.reason) : null, actor: ctx.username } });
        await db.customerTx.create({
          data: {
            type: "refund", subscriberId: payment.subscriberId, branchId: payment.branchId,
            amount: -amount, currency: payment.currency, method: payment.method,
            reference, refType: "payment", refId: paymentId,
            note: `مرتجع للدفعة ${paymentId}: ${b.reason ?? ""}`, employeeName: ctx.username,
          },
        });
        await db.activityLog.create({ data: { actor: ctx.username, action: "finance:refund", target: `$${amount}`, details: `payment ${paymentId}` } });
        return NextResponse.json({ ok: true, refund });
      }

      case "adjustment": {
        const amount = Number(b.amount);
        const subscriberId = b.subscriberId || null;
        const reference = b.reference ? String(b.reference) : `adjustment:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
        if (!amount) return badRequest("المبلغ مطلوب (موجب للأضافة، سالب للخصم)");
        if (await db.customerTx.findUnique({ where: { reference } })) return badRequest("مرجع مكرر — منع التكرار");
        const tx = await db.customerTx.create({
          data: { type: b.type === "discount" ? "discount" : "adjustment", subscriberId, branchId, amount, reference, refType: "adjustment", note: b.note ? String(b.note) : null, employeeName: ctx.username },
        });
        return NextResponse.json({ ok: true, tx });
      }

      case "register_open": {
        const id = String(b.registerId ?? "");
        const reg0 = await db.cashRegister.findFirst({ where: { id } });
        if (!reg0) return badRequest("الخزينة غير موجودة");
        const reg = await db.cashRegister.update({ where: { id }, data: { opened: true, openedAt: new Date(), openedBy: ctx.username } });
        return NextResponse.json({ ok: true, register: reg });
      }
      case "register_close": {
        const id = String(b.registerId ?? "");
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        const cash = await db.customerTx.aggregate({ where: { registerId: id, type: "payment", createdAt: { gte: since }, method: "cash" }, _sum: { amount: true } });
        const reg = await db.cashRegister.update({ where: { id }, data: { opened: false, closingNote: b.note ? String(b.note) : null } });
        return NextResponse.json({ ok: true, register: reg, cashToday: cash._sum.amount ?? 0 });
      }

      case "closing_run": {
        // daily closing — idempotent per (branchId, day) unique key
        const day = (b.day ? new Date(b.day) : new Date()).toISOString().slice(0, 10);
        const dayStart = new Date(`${day}T00:00:00.000Z`);
        const dayEnd = new Date(`${day}T23:59:59.999Z`);
        const postBranchWhere = branchId ? { branchId } : {}; // local scope (GET-scope variable not in closure)
        const where = { ...postBranchWhere, createdAt: { gte: dayStart, lte: dayEnd } };
        const [rev, ref, exp, com] = await Promise.all([
          db.customerTx.aggregate({ where: { ...where, type: { in: ["payment", "voucher_sale"] } }, _sum: { amount: true } }),
          db.customerTx.aggregate({ where: { ...where, type: "refund" }, _sum: { amount: true } }),
          db.customerTx.aggregate({ where: { ...where, type: "expense" }, _sum: { amount: true } }),
          db.customerTx.aggregate({ where: { ...where, type: "commission" }, _sum: { amount: true } }),
        ]);
        const txCount = await db.customerTx.count({ where });
        const revenue = rev._sum.amount ?? 0;
        const refunds = Math.abs(ref._sum.amount ?? 0);
        const expenses = Math.abs(exp._sum.amount ?? 0);
        const commissions = Math.abs(com._sum.amount ?? 0);
        // idempotent per (organization, branch, day) — findFirst is tenant-scoped
        const payload = { revenue, refunds, expenses, commissions, netCash: revenue - refunds - expenses - commissions, txCount, closedBy: ctx.username, closedAt: new Date() };
        const existingClosing = await db.dailyClosing.findFirst({ where: { branchId, day } });
        const closing = existingClosing
          ? await db.dailyClosing.update({ where: { id: existingClosing.id }, data: payload })
          : await db.dailyClosing.create({ data: { branchId, day, ...payload } });
        await db.activityLog.create({ data: { actor: ctx.username, action: "finance:closing", target: day, details: `net $${closing.netCash}` } });
        return NextResponse.json({ ok: true, closing });
      }

      case "subscription_create": {
        const subscriberId = String(b.subscriberId ?? "");
        const sub = await db.subscriber.findUnique({ where: { id: subscriberId }, include: { package: { select: { price: true } } } });
        if (!sub) return badRequest("المشترك غير موجود");
        const cycle = ["daily", "weekly", "monthly", "yearly"].includes(b.cycle) ? b.cycle : "monthly";
        const created = await db.recurringSubscription.create({
          data: {
            subscriberId, packageId: b.packageId || sub.packageId, routerId: sub.routerId,
            cycle, amount: Number(b.amount) || (sub.package?.price ?? 0),
            currency: String(b.currency || "USD"),
            discountPct: Number(b.discountPct) || 0,
            taxRatePct: Number(b.taxRatePct) || 0,
            nextRunAt: b.nextRunAt ? new Date(b.nextRunAt) : new Date(Date.now() + 30 * 24 * 3600 * 1000),
            autoInvoice: b.autoInvoice !== false,
          },
        });
        return NextResponse.json({ ok: true, subscription: created });
      }

      case "subscription_update": {
        const id = String(b.id ?? "");
        const sub0 = await db.recurringSubscription.findFirst({ where: { id } });
        if (!sub0) return badRequest("الاشتراك غير موجود");
        const data: Record<string, unknown> = {};
        if (b.active !== undefined) data.active = b.active === true;
        if (b.amount !== undefined) data.amount = Number(b.amount);
        if (b.nextRunAt !== undefined) data.nextRunAt = new Date(b.nextRunAt);
        const updated = await db.recurringSubscription.update({ where: { id }, data });
        return NextResponse.json({ ok: true, subscription: updated });
      }

      case "billing_run": {
        const res = await runBillingDue(ctx.username);
        return NextResponse.json({ ok: true, ...res });
      }

      default:
        return badRequest(`إجراء غير معروف: ${action}`);
    }
  } catch (e) {
    if ((e as Error).message.includes("Unique constraint")) {
      return badRequest("سجل مالي مكرر — المرجع موجود مسبقاً (منع التكرار على مستوى قاعدة البيانات)");
    }
    return serverError(e);
  }
});
