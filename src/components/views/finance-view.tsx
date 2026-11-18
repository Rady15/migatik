"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum, fmtMoney } from "@/lib/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { StatusPill } from "./hotspot-users-view";
import { DlgField } from "./packages-view";
import { Wallet, Loader2, Play, CalendarCheck, Plus, Undo2 } from "lucide-react";

interface Summary { days: number; revenue: number; refunds: number; expenses: number; commissions: number; netProfit: number; txCount: number; outstanding: number }
interface Tx { id: string; type: string; amount: number; currency: string; method: string | null; reference: string | null; note: string | null; createdAt: string; subscriber?: { code: string; name: string } | null; branch?: { name: string } | null }
interface Closing { id: string; day: string; revenue: number; refunds: number; expenses: number; commissions: number; netCash: number; txCount: number; closedBy: string | null; branch?: { name: string } | null }
interface Register { id: string; name: string; opened: boolean; openedBy: string | null; branch?: { name: string } | null }
interface Recurring { id: string; cycle: string; amount: number; discountPct: number; taxRatePct: number; nextRunAt: string; active: boolean; subscriber: { code: string; name: string }; package?: { name: string } | null }
interface PL { daily: { day: string; revenue: number; refunds: number; expenses: number; commissions: number; net: number }[]; byBranch: { branchId: string | null; type: string; amount: number }[] }
interface SubRow { id: string; code: string; name: string; status: string; packageId?: string | null }
interface BranchRow { id: string; name: string }

const TX_LABELS: Record<string, string> = {
  charge: "مستحق", payment: "قبض", refund: "مرتجع", discount: "خصم",
  adjustment: "تسوية", voucher_sale: "بيع كروت", commission: "عمولة", expense: "مصروف",
};

export function FinanceView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [closings, setClosings] = useState<Closing[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [pl, setPl] = useState<PL | null>(null);
  const [tab, setTab] = useState<"summary" | "tx" | "pl" | "closing" | "registers" | "recurring">("summary");
  const [days, setDays] = useState("30");
  const [branchF, setBranchF] = useState("all");
  const [routerId, setRouterId] = useState("all");
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [busy, setBusy] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({ subscriberId: "", amount: "", method: "cash", note: "", invoiceId: "" });
  const [refundOpen, setRefundOpen] = useState<Tx | null>(null);
  const [refundForm, setRefundForm] = useState({ amount: "", reason: "" });

  const load = useCallback(() => {
    const q = `days=${days}&branchId=${branchF}&routerId=${routerId}`;
    api<{ txs: Tx[] }>(`/api/finance?view=tx&${q}`).then((d) => setTxs(d.txs)).catch(() => {});
    api<Summary>(`/api/finance?view=summary&${q}`).then(setSummary).catch(() => {});
    api<PL>(`/api/finance?view=pl&${q}`).then(setPl).catch(() => {});
    api<{ closings: Closing[] }>(`/api/finance?view=closings&${q}`).then((d) => setClosings(d.closings)).catch(() => {});
    api<{ registers: Register[] }>(`/api/finance?view=registers`).then((d) => setRegisters(d.registers)).catch(() => {});
    api<{ subscriptions: Recurring[] }>(`/api/finance?view=subscriptions&${q}`).then((d) => setRecurring(d.subscriptions)).catch(() => {});
  }, [days, branchF, routerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ branches: BranchRow[] }>("/api/branches").then((d) => setBranches(d.branches)).catch(() => {});
    api<{ subscribers: SubRow[] }>("/api/subscribers?pageSize=100").then((d) => setSubs(d.subscribers)).catch(() => {});
  }, []);

  async function act(body: Record<string, unknown>, key: string, done?: () => void) {
    setBusy(key);
    try {
      const res = await api<{ ok: boolean; message?: string; processed?: number; invoicesCreated?: number; cashToday?: number }>("/api/finance", { method: "POST", json: body });
      toast.success(res.message || (ar ? "تم التنفيذ" : "Done"));
      done?.();
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  const TABS = [
    ["summary", ar ? "الملخص" : "Summary"], ["tx", ar ? "دفتر الحركات" : "Ledger"],
    ["pl", ar ? "الأرباح والخسائر" : "P&L"], ["closing", ar ? "الإقفال اليومي" : "Daily closing"],
    ["registers", ar ? "الخزائن" : "Cash registers"], ["recurring", ar ? "الاشتراكات المتكررة" : "Recurring"],
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white flex items-center gap-2"><Wallet className="w-5 h-5 text-[#22D3EE]" /> {ar ? "المالية والمحاسبة" : "Finance & Accounting"}</h1>
        <div className="flex items-center gap-2">
          <RouterSelect value={routerId} onChange={setRouterId} className="w-48" />
          <select value={branchF} onChange={(e) => setBranchF(e.target.value)} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
            <option value="all">{ar ? "كل الفروع" : "All branches"}</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(e.target.value)} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
            {["7", "30", "90", "365"].map((d) => <option key={d} value={d}>{ar ? `آخر ${d} يوم` : `Last ${d} days`}</option>)}
          </select>
          <Button onClick={() => setPayOpen(true)} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs gap-1.5"><Plus className="w-3.5 h-3.5" /> {ar ? "قبض جديد" : "New payment"}</Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`text-xs font-bold rounded-lg px-3 py-1.5 border ${tab === k ? "bg-[#1685FF] border-[#1685FF] text-white" : "bg-[#0B1428] border-[#24344F] text-[#CBD5E1]"}`}>{label}</button>
        ))}
      </div>

      {tab === "summary" && (
        !summary ? <Skeleton className="h-40 rounded-xl bg-[#111C33]" /> : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {([
              [ar ? "الإيرادات" : "Revenue", fmtMoney(summary.revenue), "text-emerald-300"],
              [ar ? "المرتجعات" : "Refunds", fmtMoney(summary.refunds), "text-red-300"],
              [ar ? "المصروفات" : "Expenses", fmtMoney(summary.expenses), "text-amber-300"],
              [ar ? "العمولات" : "Commissions", fmtMoney(summary.commissions), "text-blue-300"],
              [ar ? "صافي الربح" : "Net profit", fmtMoney(summary.netProfit), summary.netProfit >= 0 ? "text-emerald-300" : "text-red-300"],
              [ar ? "مستحقات غير محصلة" : "Outstanding", fmtMoney(summary.outstanding), "text-orange-300"],
              [ar ? "عدد الحركات" : "Transactions", fmtNum(summary.txCount), "text-[#CBD5E1]"],
            ] as [string, string, string][]).map(([l, v, c], i) => (
              <div key={i} className="panel p-3">
                <div className="text-[11px] text-[#8CA3C3]">{l}</div>
                <div className={`text-base font-extrabold num ${c}`} dir="ltr">{v}</div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === "tx" && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="mt-table w-full min-w-[680px]">
              <thead><tr><th>{ar ? "النوع" : "Type"}</th><th>{ar ? "المبلغ" : "Amount"}</th><th>{ar ? "المرجع" : "Reference"}</th><th>{ar ? "المشترك" : "Subscriber"}</th><th>{ar ? "الفرع" : "Branch"}</th><th>{ar ? "التاريخ" : "Date"}</th><th></th></tr></thead>
              <tbody>
                {txs.length === 0 && <tr><td colSpan={7} className="text-center text-[#64748B] py-8">—</td></tr>}
                {txs.map((t) => (
                  <tr key={t.id} className="hover:bg-[#121E38]/70">
                    <td><span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${t.amount >= 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{TX_LABELS[t.type] ?? t.type}</span></td>
                    <td className={`num font-bold ${t.amount >= 0 ? "text-emerald-300" : "text-red-300"}`} dir="ltr">{fmtMoney(t.amount, t.currency)}</td>
                    <td className="num text-[9.5px] text-[#64748B] max-w-[180px] truncate" dir="ltr" title={t.reference ?? ""}>{t.reference ?? "—"}</td>
                    <td className="text-[#CBD5E1]">{t.subscriber?.name ?? "—"}</td>
                    <td className="text-[#8CA3C3]">{t.branch?.name ?? "—"}</td>
                    <td className="num text-[9.5px] text-[#8CA3C3]" dir="ltr">{t.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td>{t.type === "payment" && <button onClick={() => { setRefundOpen(t); setRefundForm({ amount: String(Math.abs(t.amount)), reason: "" }); }} className="text-amber-300 hover:text-amber-200 text-[10px] flex items-center gap-1"><Undo2 className="w-3 h-3" />{ar ? "مرتجع" : "Refund"}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "pl" && (
        !pl ? <Skeleton className="h-40 rounded-xl bg-[#111C33]" /> : (
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="mt-table w-full min-w-[560px]">
                <thead><tr><th>{ar ? "اليوم" : "Day"}</th><th>{ar ? "الإيرادات" : "Revenue"}</th><th>{ar ? "المرتجعات" : "Refunds"}</th><th>{ar ? "المصروفات" : "Expenses"}</th><th>{ar ? "العمولات" : "Commissions"}</th><th>{ar ? "الصافي" : "Net"}</th></tr></thead>
                <tbody>
                  {pl.daily.length === 0 && <tr><td colSpan={6} className="text-center text-[#64748B] py-8">—</td></tr>}
                  {pl.daily.slice().reverse().map((r) => (
                    <tr key={r.day}>
                      <td className="num text-[#8CA3C3]" dir="ltr">{r.day}</td>
                      <td className="num text-emerald-300" dir="ltr">{fmtMoney(r.revenue)}</td>
                      <td className="num text-red-300" dir="ltr">{fmtMoney(r.refunds)}</td>
                      <td className="num text-amber-300" dir="ltr">{fmtMoney(r.expenses)}</td>
                      <td className="num text-blue-300" dir="ltr">{fmtMoney(r.commissions)}</td>
                      <td className={`num font-bold ${r.net >= 0 ? "text-emerald-300" : "text-red-300"}`} dir="ltr">{fmtMoney(r.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {tab === "closing" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button onClick={() => act({ action: "closing_run", branchId: branchF === "all" ? null : branchF }, "closing")} disabled={!!busy} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white text-xs gap-1.5">
              {busy === "closing" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarCheck className="w-3.5 h-3.5" />}
              {ar ? "إقفال اليوم الحالي" : "Close today"}
            </Button>
            <span className="text-[10.5px] text-[#8CA3C3]">{ar ? "الإقفال محصّن ضد التكرار لكل (فرع، يوم) — يعيد الحساب عند التكرار بدل إنشاء سجلين" : "Closing is idempotent per (branch, day) — re-running recalculates instead of duplicating"}</span>
          </div>
          <div className="panel overflow-hidden">
            <table className="mt-table w-full min-w-[640px]">
              <thead><tr><th>{ar ? "اليوم" : "Day"}</th><th>{ar ? "الإيرادات" : "Revenue"}</th><th>{ar ? "المرتجعات" : "Refunds"}</th><th>{ar ? "المصروفات" : "Expenses"}</th><th>{ar ? "العمولات" : "Commissions"}</th><th>{ar ? "الصافي" : "Net cash"}</th><th>{ar ? "أقفله" : "Closed by"}</th></tr></thead>
              <tbody>
                {closings.length === 0 && <tr><td colSpan={7} className="text-center text-[#64748B] py-8">—</td></tr>}
                {closings.map((c) => (
                  <tr key={c.id}>
                    <td className="num text-[#E2E8F0]" dir="ltr">{c.day}</td>
                    <td className="num text-emerald-300" dir="ltr">{fmtMoney(c.revenue)}</td>
                    <td className="num text-red-300" dir="ltr">{fmtMoney(c.refunds)}</td>
                    <td className="num text-amber-300" dir="ltr">{fmtMoney(c.expenses)}</td>
                    <td className="num text-blue-300" dir="ltr">{fmtMoney(c.commissions)}</td>
                    <td className={`num font-bold ${c.netCash >= 0 ? "text-emerald-300" : "text-red-300"}`} dir="ltr">{fmtMoney(c.netCash)}</td>
                    <td className="text-[#8CA3C3] text-[10px]">{c.closedBy ?? "—"} {c.branch ? `· ${c.branch.name}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "registers" && (
        <div className="grid md:grid-cols-3 gap-2.5">
          {registers.length === 0 && <div className="text-xs text-[#64748B]">{ar ? "لا خزائن — أضف واحدة من قاعدة البيانات" : "No registers"}</div>}
          {registers.map((r) => (
            <div key={r.id} className="panel p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">{r.name}</span>
                <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${r.opened ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-500/20 text-slate-300"}`}>{r.opened ? (ar ? "مفتوحة" : "Open") : (ar ? "مغلقة" : "Closed")}</span>
              </div>
              <div className="text-[10px] text-[#8CA3C3]">{r.branch?.name ?? "—"} {r.openedBy ? `· ${r.openedBy}` : ""}</div>
              <div className="flex gap-1.5">
                {!r.opened ? (
                  <Button size="sm" onClick={() => act({ action: "register_open", registerId: r.id }, `reg-${r.id}`)} disabled={!!busy} className="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]">{ar ? "فتح" : "Open"}</Button>
                ) : (
                  <Button size="sm" onClick={() => act({ action: "register_close", registerId: r.id }, `reg-${r.id}`)} disabled={!!busy} className="bg-amber-600 hover:bg-amber-500 text-white text-[10px]">{ar ? "إغلاق" : "Close"}</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "recurring" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button onClick={() => act({ action: "billing_run" }, "billing")} disabled={!!busy} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white text-xs gap-1.5">
              {busy === "billing" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {ar ? "تشغيل دورة الفوترة الآن" : "Run billing cycle now"}
            </Button>
            <span className="text-[10.5px] text-[#8CA3C3]">{ar ? "المجدول يعمل تلقائياً كل دقيقة — الفوترة محصّنة ضد التكرار بمرجع فريد لكل (اشتراك، دورة)" : "Scheduler runs every minute — billing is idempotent per (subscription, period)"}</span>
          </div>
          <div className="panel overflow-hidden">
            <table className="mt-table w-full min-w-[620px]">
              <thead><tr><th>{ar ? "المشترك" : "Subscriber"}</th><th>{ar ? "الباقة" : "Package"}</th><th>{ar ? "الدورة" : "Cycle"}</th><th>{ar ? "المبلغ" : "Amount"}</th><th>{ar ? "الخصم/الضريبة" : "Disc/Tax"}</th><th>{ar ? "التشغيل القادم" : "Next run"}</th><th>{ar ? "الحالة" : "Active"}</th></tr></thead>
              <tbody>
                {recurring.length === 0 && <tr><td colSpan={7} className="text-center text-[#64748B] py-8">{ar ? "لا اشتراكات متكررة" : "No recurring subscriptions"}</td></tr>}
                {recurring.map((r) => (
                  <tr key={r.id}>
                    <td className="text-[#E2E8F0] font-bold">{r.subscriber.name}<div className="text-[9px] text-[#8CA3C3] num" dir="ltr">{r.subscriber.code}</div></td>
                    <td className="text-[#CBD5E1]">{r.package?.name ?? "—"}</td>
                    <td className="text-[#CBD5E1]">{r.cycle}</td>
                    <td className="num text-[#E2E8F0]" dir="ltr">{fmtMoney(r.amount)}</td>
                    <td className="num text-[#8CA3C3]" dir="ltr">{r.discountPct}% / {r.taxRatePct}%</td>
                    <td className="num text-[#8CA3C3]" dir="ltr">{r.nextRunAt.slice(0, 10)}</td>
                    <td><button onClick={() => act({ action: "subscription_update", id: r.id, active: !r.active }, `rec-${r.id}`)} className={`text-[10px] font-bold rounded px-2 py-0.5 ${r.active ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-500/20 text-slate-300"}`}>{r.active ? (ar ? "مفعّل — إيقاف؟" : "Active — pause?") : (ar ? "موقوف — تفعيل؟" : "Paused — resume?")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* payment dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md">
          <DialogHeader><DialogTitle className="text-white">{ar ? "قبض جديد" : "New payment"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "المشترك" : "Subscriber"}</label>
              <select value={payForm.subscriberId} onChange={(e) => setPayForm({ ...payForm, subscriberId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {subs.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
              </select>
            </div>
            <DlgField label={ar ? "المبلغ" : "Amount"} value={payForm.amount} onChange={(v) => setPayForm({ ...payForm, amount: v })} dir="ltr" type="number" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "الطريقة" : "Method"}</label>
              <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                {["cash", "bank", "electronic"].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="col-span-2"><DlgField label={ar ? "ملاحظة" : "Note"} value={payForm.note} onChange={(v) => setPayForm({ ...payForm, note: v })} /></div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setPayOpen(false)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={() => act({ action: "payment", ...payForm, amount: Number(payForm.amount), subscriberId: payForm.subscriberId || null, branchId: branchF === "all" ? null : branchF }, "pay", () => setPayOpen(false))} disabled={!!busy} className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold gap-2">
              {busy === "pay" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {ar ? "تسجيل القبض" : "Save payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* refund dialog */}
      <Dialog open={!!refundOpen} onOpenChange={(v) => { if (!v) setRefundOpen(null); }}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md">
          <DialogHeader><DialogTitle className="text-white flex items-center gap-2"><Undo2 className="w-4 h-4 text-amber-300" /> {ar ? "مرتجع دفعة" : "Refund payment"}</DialogTitle></DialogHeader>
          {refundOpen && (
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 text-xs text-[#8CA3C3]">{ar ? "الدفعة الأصلية" : "Original payment"}: <span className="text-[#E2E8F0] num" dir="ltr">{fmtMoney(Math.abs(refundOpen.amount))} · {refundOpen.createdAt.slice(0, 16).replace("T", " ")}</span></div>
              <DlgField label={ar ? "مبلغ المرتجع" : "Refund amount"} value={refundForm.amount} onChange={(v) => setRefundForm({ ...refundForm, amount: v })} dir="ltr" type="number" />
              <DlgField label={ar ? "السبب" : "Reason"} value={refundForm.reason} onChange={(v) => setRefundForm({ ...refundForm, reason: v })} />
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setRefundOpen(null)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={() => refundOpen && act({ action: "refund", paymentId: refundOpen.id, amount: Number(refundForm.amount), reason: refundForm.reason }, "refund", () => setRefundOpen(null))} disabled={!!busy} className="bg-amber-600 hover:bg-amber-500 text-white font-bold gap-2">
              {busy === "refund" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
              {ar ? "تنفيذ المرتجع" : "Process refund"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
