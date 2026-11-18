"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtDateTime } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { DlgField } from "./packages-view";
import { Plus, Loader2, LifeBuoy, History } from "lucide-react";

interface Ticket { id: string; subject: string; message: string; requester: string; priority: string; status: string; createdAt: string }
interface Log { id: string; actor: string; action: string; target: string | null; details: string | null; createdAt: string }

export function SupportView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ subject: "", message: "", priority: "medium" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<{ tickets: Ticket[]; activity: Log[] }>("/api/support")
      .then((d) => { setTickets(d.tickets); setLogs(d.activity); })
      .catch((e) => toast.error((e as Error).message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.subject || !form.message) {
      toast.error(lang === "ar" ? "الموضوع والرسالة مطلوبان" : "Subject and message required");
      return;
    }
    setSaving(true);
    try {
      await api("/api/support", { method: "POST", json: form });
      toast.success(t("saved"));
      setOpen(false);
      setForm({ subject: "", message: "", priority: "medium" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(tk: Ticket, status: string) {
    try {
      await api("/api/support", { method: "PATCH", json: { id: tk.id, status } });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const statusLabels: Record<string, string> = { open: "مفتوحة", in_progress: "قيد المعالجة", resolved: "تم الحل", closed: "مغلقة" };
  const prioColors: Record<string, string> = { high: "text-red-300", medium: "text-amber-300", low: "text-emerald-300" };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-extrabold text-white">{t("support")}</h1>
        <Button onClick={() => setOpen(true)} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
          <Plus className="w-4 h-4" /> {lang === "ar" ? "تذكرة جديدة" : "New ticket"}
        </Button>
      </div>

      {!tickets ? <Skeleton className="h-64 rounded-xl bg-[#111C33]" /> : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {tickets.map((tk) => (
            <div key={tk.id} className="panel p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <LifeBuoy className="w-4 h-4 text-[#22D3EE] shrink-0" />
                  <span className="text-sm font-bold text-white truncate">{tk.subject}</span>
                </div>
                <span className={`text-[10px] font-bold ${prioColors[tk.priority]}`}>
                  {tk.priority === "high" ? "عالية" : tk.priority === "low" ? "منخفضة" : "متوسطة"}
                </span>
              </div>
              <p className="text-[11.5px] text-[#8CA3C3] leading-relaxed">{tk.message}</p>
              <div className="flex items-center justify-between text-[10px] text-[#64748B]">
                <span>{tk.requester}</span>
                <span className="num" dir="ltr">{fmtDateTime(tk.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1.5 border-t border-[#1B2946]/60 pt-2.5">
                {["open", "in_progress", "resolved", "closed"].map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatus(tk, st)}
                    className={`text-[10px] font-bold rounded-md px-2 py-1 border transition-colors ${tk.status === st ? "bg-[#1685FF]/20 border-[#1685FF]/50 text-[#5CA9FF]" : "bg-[#0B1428] border-[#24344F] text-[#8CA3C3] hover:bg-[#17243B]"}`}
                  >
                    {statusLabels[st]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <History className="w-4 h-4 text-[#1685FF]" />
          <h2 className="text-sm font-extrabold text-white">{lang === "ar" ? "سجل النشاط" : "Activity log"}</h2>
        </div>
        <div className="max-h-72 overflow-y-auto space-y-1.5">
          {logs.map((lg) => (
            <div key={lg.id} className="flex items-center justify-between text-[11px] bg-[#0B1428] border border-[#1B2946]/60 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <span className="text-[#E2E8F0] font-bold">{lg.actor}</span>
                <span className="text-[#8CA3C3]"> — {lg.action}</span>
                {lg.details && <span className="text-[#64748B]"> ({lg.details})</span>}
              </div>
              <span className="text-[9.5px] text-[#55688A] num shrink-0" dir="ltr">{fmtDateTime(lg.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md">
          <DialogHeader><DialogTitle className="text-white">{lang === "ar" ? "تذكرة دعم جديدة" : "New support ticket"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <DlgField label={lang === "ar" ? "الموضوع" : "Subject"} value={form.subject} onChange={(v) => setForm({ ...form, subject: v })} />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "الرسالة" : "Message"}</label>
              <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={4} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white" />
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "الأولوية" : "Priority"}</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="low">{lang === "ar" ? "منخفضة" : "Low"}</option>
                <option value="medium">{lang === "ar" ? "متوسطة" : "Medium"}</option>
                <option value="high">{lang === "ar" ? "عالية" : "High"}</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={save} disabled={saving} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
