"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum, fmtMoney, fmtDate } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { StatusPill } from "./hotspot-users-view";
import { DlgField } from "./packages-view";
import { Plus, Loader2, Receipt, Banknote, FileText, Printer } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Invoice {
  id: string; number: string; customerName: string; customerPhone: string | null; description: string | null;
  amount: number; discount: number; taxRate: number; taxAmount: number; total: number; status: string;
  dueDate: string | null; createdAt: string;
}
interface Payment {
  id: string; customerName: string | null; amount: number; currency: string; method: string;
  reference: string | null; createdAt: string; invoice?: { number: string } | null;
}

export function PaymentsView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [invOpen, setInvOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [printInv, setPrintInv] = useState<Invoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [routerId, setRouterId] = useState("all");
  const [invForm, setInvForm] = useState({ customerName: "", customerPhone: "", description: "", amount: "", discount: "0", taxRate: "14", dueDate: "" });
  const [payForm, setPayForm] = useState({ customerName: "", amount: "", method: "cash", reference: "", note: "" });

  const load = useCallback(() => {
    api<{ invoices: Invoice[] }>(`/api/invoices?routerId=${routerId}`).then((d) => setInvoices(d.invoices)).catch((e) => toast.error((e as Error).message));
    api<{ payments: Payment[] }>(`/api/payments?routerId=${routerId}`).then((d) => setPayments(d.payments)).catch((e) => toast.error((e as Error).message));
  }, [routerId]);

  useEffect(() => { load(); }, [load]);

  async function saveInvoice() {
    if (!invForm.customerName || !invForm.amount) {
      toast.error(lang === "ar" ? "العميل والمبلغ مطلوبان" : "Customer and amount required");
      return;
    }
    setSaving(true);
    try {
      await api("/api/invoices", { method: "POST", json: invForm });
      toast.success(t("saved"));
      setInvOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function markPaid(inv: Invoice) {
    try {
      await api(`/api/invoices/${inv.id}`, { method: "PATCH", json: { status: "paid" } });
      toast.success(t("saved"));
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function savePayment() {
    if (!payForm.amount) {
      toast.error(lang === "ar" ? "المبلغ مطلوب" : "Amount required");
      return;
    }
    setSaving(true);
    try {
      await api("/api/payments", { method: "POST", json: payForm });
      toast.success(t("saved"));
      setPayOpen(false);
      setPayForm({ customerName: "", amount: "", method: "cash", reference: "", note: "" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const unpaidTotal = invoices?.filter((i) => i.status === "unpaid" || i.status === "overdue").reduce((a, i) => a + i.total, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("payments")}</h1>
        <div className="flex items-center gap-2">
          <RouterSelect value={routerId} onChange={setRouterId} className="w-48" />
          <Button onClick={() => setPayOpen(true)} variant="ghost" className="text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/10 text-xs gap-1.5 font-bold">
            <Banknote className="w-3.5 h-3.5" /> {t("recordPayment")}
          </Button>
          <Button onClick={() => setInvOpen(true)} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Plus className="w-4 h-4" /> {t("newInvoice")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <SumTile label={lang === "ar" ? "إيرادات مسجلة" : "Recorded"} value={fmtMoney(payments?.reduce((a, p) => a + p.amount, 0) ?? 0)} color="text-emerald-300" />
        <SumTile label={lang === "ar" ? "فواتير غير محصلة" : "Outstanding"} value={fmtMoney(unpaidTotal)} color="text-amber-300" />
        <SumTile label={lang === "ar" ? "عدد الفواتير" : "Invoices"} value={fmtNum(invoices?.length ?? 0)} color="text-blue-300" />
        <SumTile label={lang === "ar" ? "عدد الدفعات" : "Payments"} value={fmtNum(payments?.length ?? 0)} color="text-violet-300" />
      </div>

      <Tabs defaultValue="invoices" dir={lang === "ar" ? "rtl" : "ltr"}>
        <TabsList className="bg-[#0E1A31] border border-[#24344F]">
          <TabsTrigger value="invoices" className="text-xs data-[state=active]:bg-[#17243B] data-[state=active]:text-white text-[#8CA3C3] gap-1.5">
            <FileText className="w-3.5 h-3.5" /> {t("invoicesMgmt")}
          </TabsTrigger>
          <TabsTrigger value="payments" className="text-xs data-[state=active]:bg-[#17243B] data-[state=active]:text-white text-[#8CA3C3] gap-1.5">
            <Receipt className="w-3.5 h-3.5" /> {t("payments")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="invoices">
          {!invoices ? <Skeleton className="h-72 rounded-xl bg-[#111C33]" /> : (
            <div className="panel overflow-hidden mt-2">
              <div className="overflow-x-auto">
                <table className="mt-table w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th>{t("invoiceNo")}</th>
                      <th>{t("customer")}</th>
                      <th>{t("amount")}</th>
                      <th>{t("totalAmount")}</th>
                      <th>{t("status")}</th>
                      <th>{t("date")}</th>
                      <th className="w-32">{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.length === 0 && <tr><td colSpan={7} className="text-center text-[#64748B] py-8">{t("noData")}</td></tr>}
                    {invoices.slice(0, 50).map((inv) => (
                      <tr key={inv.id} className="hover:bg-[#121E38]/70 transition-colors">
                        <td className="num font-bold text-[#E2E8F0]" dir="ltr">{inv.number}</td>
                        <td className="text-[#CBD5E1]">{inv.customerName}</td>
                        <td className="num" dir="ltr">{fmtMoney(inv.amount)}</td>
                        <td className="num font-bold text-white" dir="ltr">{fmtMoney(inv.total)}</td>
                        <td><StatusPill status={inv.status} lang={lang} /></td>
                        <td className="num text-[#8CA3C3]" dir="ltr">{fmtDate(inv.createdAt)}</td>
                        <td>
                          <div className="flex items-center gap-1">
                            {inv.status !== "paid" && (
                              <Button size="sm" variant="ghost" onClick={() => markPaid(inv)} className="text-[10px] text-emerald-300 hover:bg-emerald-500/10 h-7 px-2 font-bold">
                                {t("paid")}
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" onClick={() => setPrintInv(inv)} className="w-7 h-7 text-[#CBD5E1] hover:bg-[#17243B]" title={t("print")}>
                              <Printer className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="payments">
          {!payments ? <Skeleton className="h-72 rounded-xl bg-[#111C33]" /> : (
            <div className="panel overflow-hidden mt-2">
              <div className="overflow-x-auto">
                <table className="mt-table w-full min-w-[560px]">
                  <thead>
                    <tr>
                      <th>{t("customer")}</th>
                      <th>{t("amount")}</th>
                      <th>{t("method")}</th>
                      <th>{t("invoiceNo")}</th>
                      <th>{t("date")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.slice(0, 60).map((p) => (
                      <tr key={p.id} className="hover:bg-[#121E38]/70 transition-colors">
                        <td className="text-[#E2E8F0] font-bold">{p.customerName ?? "—"}</td>
                        <td className="num font-bold text-emerald-300" dir="ltr">{fmtMoney(p.amount, p.currency)}</td>
                        <td><MethodLabel method={p.method} lang={lang} /></td>
                        <td className="num text-[#8CA3C3]" dir="ltr">{p.invoice?.number ?? "—"}</td>
                        <td className="num text-[#8CA3C3]" dir="ltr">{fmtDate(p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* invoice dialog */}
      <Dialog open={invOpen} onOpenChange={setInvOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white">{t("newInvoice")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <DlgField label={t("customer")} value={invForm.customerName} onChange={(v) => setInvForm({ ...invForm, customerName: v })} />
            <DlgField label={t("phone")} value={invForm.customerPhone} onChange={(v) => setInvForm({ ...invForm, customerPhone: v })} dir="ltr" />
            <DlgField label={t("amount")} value={invForm.amount} onChange={(v) => setInvForm({ ...invForm, amount: v })} dir="ltr" type="number" />
            <DlgField label={lang === "ar" ? "الخصم" : "Discount"} value={invForm.discount} onChange={(v) => setInvForm({ ...invForm, discount: v })} dir="ltr" type="number" />
            <DlgField label={lang === "ar" ? "الضريبة %" : "Tax %"} value={invForm.taxRate} onChange={(v) => setInvForm({ ...invForm, taxRate: v })} dir="ltr" type="number" />
            <DlgField label={t("expires")} value={invForm.dueDate} onChange={(v) => setInvForm({ ...invForm, dueDate: v })} dir="ltr" type="date" />
            <div className="col-span-2">
              <DlgField label={lang === "ar" ? "الوصف" : "Description"} value={invForm.description} onChange={(v) => setInvForm({ ...invForm, description: v })} />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setInvOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={saveInvoice} disabled={saving} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* payment dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-white">{t("recordPayment")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <DlgField label={t("customer")} value={payForm.customerName} onChange={(v) => setPayForm({ ...payForm, customerName: v })} />
            <DlgField label={t("amount")} value={payForm.amount} onChange={(v) => setPayForm({ ...payForm, amount: v })} dir="ltr" type="number" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("method")}</label>
              <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="cash">{t("cash")}</option>
                <option value="bank">{t("bank")}</option>
                <option value="electronic">{t("electronic")}</option>
                <option value="manual">{t("manual")}</option>
              </select>
            </div>
            <DlgField label={lang === "ar" ? "مرجع" : "Reference"} value={payForm.reference} onChange={(v) => setPayForm({ ...payForm, reference: v })} dir="ltr" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setPayOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={savePayment} disabled={saving} className="bg-[#0FA36B] hover:bg-[#12BE80] text-white font-bold gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* invoice print */}
      {printInv && <InvoicePrint invoice={printInv} onClose={() => setPrintInv(null)} />}
    </div>
  );
}

function SumTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[11px] text-[#8CA3C3] font-bold">{label}</div>
      <div className={`text-base font-extrabold num mt-0.5 ${color}`} dir="ltr">{value}</div>
    </div>
  );
}

function MethodLabel({ method, lang }: { method: string; lang?: string }) {
  const map: Record<string, string> = { cash: "نقدي", bank: "تحويل بنكي", electronic: "إلكتروني", manual: "يدوي" };
  return <span className="text-[#CBD5E1]">{lang === "en" ? method : map[method] ?? method}</span>;
}

function InvoicePrint({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-[#0E1A31] border-[#24344F] max-w-lg">
        <DialogHeader><DialogTitle className="text-white">{lang === "ar" ? "معاينة الفاتورة" : "Invoice preview"}</DialogTitle></DialogHeader>
        <div className="print-area bg-white text-slate-900 rounded-lg p-5" dir="ltr">
          <div className="flex items-start justify-between border-b border-slate-200 pb-3 mb-3">
            <div>
              <div className="font-extrabold text-lg text-[#0B3B8C]">MikroTik Management</div>
              <div className="text-[11px] text-slate-500">Internet Services Provider</div>
            </div>
            <div className="text-end">
              <div className="font-extrabold text-sm">{invoice.number}</div>
              <div className="text-[11px] text-slate-500">{fmtDate(invoice.createdAt)}</div>
            </div>
          </div>
          <div className="mb-3 text-[12px]">
            <div className="font-bold">{invoice.customerName}</div>
            {invoice.customerPhone && <div className="text-slate-500 num">{invoice.customerPhone}</div>}
            {invoice.description && <div className="text-slate-600 mt-1">{invoice.description}</div>}
          </div>
          <table className="w-full text-[12px] border border-slate-200 rounded">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 px-3">Amount</td>
                <td className="py-1.5 px-3 text-end num font-bold">{fmtMoney(invoice.amount)}</td>
              </tr>
              {invoice.discount > 0 && (
                <tr className="border-b border-slate-100">
                  <td className="py-1.5 px-3">Discount</td>
                  <td className="py-1.5 px-3 text-end num">- {fmtMoney(invoice.discount)}</td>
                </tr>
              )}
              <tr className="border-b border-slate-100">
                <td className="py-1.5 px-3">Tax ({invoice.taxRate}%)</td>
                <td className="py-1.5 px-3 text-end num">{fmtMoney(invoice.taxAmount)}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 font-extrabold">Total</td>
                <td className="py-2 px-3 text-end num font-extrabold text-[#0B3B8C]">{fmtMoney(invoice.total)}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="font-bold">{invoice.status}</span>
            {invoice.dueDate && <span className="text-slate-500">Due: {fmtDate(invoice.dueDate)}</span>}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} className="text-[#CBD5E1]">{lang === "ar" ? "إغلاق" : "Close"}</Button>
          <Button onClick={() => window.print()} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-1.5 text-xs">
            <Printer className="w-3.5 h-3.5" /> {lang === "ar" ? "طباعة / PDF" : "Print / PDF"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
