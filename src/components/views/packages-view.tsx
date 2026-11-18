"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum, fmtMoney } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { StatusPill } from "./hotspot-users-view";
import { Plus, Pencil, Trash2, Loader2, Package as PackageIcon } from "lucide-react";

interface Pkg {
  id: string; name: string; description: string | null; downloadMbps: number; uploadMbps: number;
  dataLimitMb: number | null; durationHours: number; price: number; currency: string; profile: string;
  active: boolean; routerId?: string | null; router?: { name: string } | null; _count?: { hotspotUsers: number };
}

const emptyForm = {
  id: "", name: "", description: "", downloadMbps: "10", uploadMbps: "5",
  dataLimitMb: "", durationHours: "720", price: "10", profile: "", routerId: "", active: true,
};

const DURATIONS = [
  { h: 1, ar: "ساعة واحدة", en: "Hourly" },
  { h: 24, ar: "يومي", en: "Daily" },
  { h: 168, ar: "أسبوعي", en: "Weekly" },
  { h: 720, ar: "شهري", en: "Monthly" },
];

export function PackagesView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [routers, setRouters] = useState<{ id: string; name: string }[]>([]);
  const [routerId, setRouterId] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletePkg, setDeletePkg] = useState<Pkg | null>(null);

  const load = useCallback(() => {
    api<{ packages: Pkg[] }>(`/api/packages?routerId=${routerId}`).then((d) => setPkgs(d.packages)).catch((e) => toast.error((e as Error).message));
    api<{ routers: { id: string; name: string }[] }>("/api/routers").then((d) => setRouters(d.routers)).catch(() => {});
  }, [routerId]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.name) { toast.error(lang === "ar" ? "اسم الباقة مطلوب" : "Name required"); return; }
    setSaving(true);
    try {
      if (form.id) {
        const res = await api<{ routerSynced?: boolean; routerName?: string }>(`/api/packages/${form.id}`, { method: "PATCH", json: { ...form, dataLimitMb: form.dataLimitMb || null } });
        toast.success(res.routerSynced ? `${t("saved")} · ${lang === "ar" ? "تم التحديث على" : "updated on"} ${res.routerName ?? "RouterOS"}` : t("saved"));
      } else {
        const res = await api<{ routerSynced?: boolean; routerName?: string }>("/api/packages", { method: "POST", json: { ...form, dataLimitMb: form.dataLimitMb || null } });
        toast.success(res.routerSynced ? `${t("saved")} · ${lang === "ar" ? "تمت الإضافة إلى" : "created on"} ${res.routerName ?? "RouterOS"}` : t("saved"));
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p: Pkg) {
    try {
      await api(`/api/packages/${p.id}`, { method: "PATCH", json: { active: !p.active } });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove() {
    if (!deletePkg) return;
    try {
      await api(`/api/packages/${deletePkg.id}`, { method: "DELETE" });
      toast.success(t("deleted"));
      setDeletePkg(null);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("packages")}</h1>
        <div className="flex items-center gap-2">
          <RouterSelect value={routerId} onChange={setRouterId} className="w-52" />
          <Button onClick={() => { setForm(emptyForm); setDialogOpen(true); }} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Plus className="w-4 h-4" /> {t("addPackage")}
          </Button>
        </div>
      </div>

      {!pkgs ? (
        <Skeleton className="h-80 rounded-xl bg-[#111C33]" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {pkgs.map((p) => (
            <div key={p.id} className={`panel p-4 space-y-2.5 ${!p.active ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-[#5B3FD6]/20 border border-[#5B3FD6]/40 flex items-center justify-center">
                    <PackageIcon className="w-5 h-5 text-[#9F8CFF]" />
                  </div>
                  <div>
                    <div className="text-white font-extrabold text-sm" dir="ltr">{p.name}</div>
                    <div className="text-[10px] text-[#64748B]">{p.description ?? "—"}</div>
                  </div>
                </div>
                <span className={`text-xs font-extrabold num ${p.active ? "text-emerald-400" : "text-slate-400"}`} dir="ltr">
                  {fmtMoney(p.price, p.currency)}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <MiniStat label={lang === "ar" ? "تحميل" : "Down"} value={`${p.downloadMbps}M`} />
                <MiniStat label={lang === "ar" ? "رفع" : "Up"} value={`${p.uploadMbps}M`} />
                <MiniStat label={lang === "ar" ? "الحد" : "Limit"} value={p.dataLimitMb ? `${Math.round(p.dataLimitMb / 1024)}G` : t("unlimited")} />
                <MiniStat label={lang === "ar" ? "المدة" : "Duration"} value={DURATIONS.find((d) => d.h === p.durationHours)?.[lang] ?? `${p.durationHours}h`} />
              </div>
              <div className="flex items-center justify-between text-[10.5px] text-[#64748B]">
                <span>{fmtNum(p._count?.hotspotUsers ?? 0)} {lang === "ar" ? "مشترك" : "subscribers"}</span>
                <span className="num" dir="ltr">{p.profile}</span>
              </div>
              <div className="flex items-center gap-2 border-t border-[#1B2946]/60 pt-3">
                <Button size="sm" onClick={() => toggleActive(p)} className={`flex-1 text-[11px] font-bold ${p.active ? "bg-amber-500/15 border border-amber-400/40 text-amber-300 hover:bg-amber-500/25" : "bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/25"}`}>
                  {p.active ? t("suspend") : t("activate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  setForm({
                    id: p.id, name: p.name, description: p.description ?? "", downloadMbps: String(p.downloadMbps),
                    uploadMbps: String(p.uploadMbps), dataLimitMb: p.dataLimitMb ? String(p.dataLimitMb) : "",
                    durationHours: String(p.durationHours), price: String(p.price), profile: p.profile,
                    routerId: p.routerId ?? "", active: p.active,
                  });
                  setDialogOpen(true);
                }} className="text-[#CBD5E1] hover:bg-[#17243B]">
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeletePkg(p)} className="text-[#FCA5A5] hover:bg-[#2A1520]">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white">{form.id ? t("edit") : t("addPackage")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <DlgField label={t("pkgName")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <DlgField label={t("price")} value={form.price} onChange={(v) => setForm({ ...form, price: v })} dir="ltr" type="number" />
            <DlgField label={t("downSpeed")} value={form.downloadMbps} onChange={(v) => setForm({ ...form, downloadMbps: v })} dir="ltr" type="number" />
            <DlgField label={t("upSpeed")} value={form.uploadMbps} onChange={(v) => setForm({ ...form, uploadMbps: v })} dir="ltr" type="number" />
            <DlgField label={`${t("dataLimit")} — ${t("unlimited")} = 0`} value={form.dataLimitMb} onChange={(v) => setForm({ ...form, dataLimitMb: v })} dir="ltr" type="number" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("durationH")}</label>
              <select value={form.durationHours} onChange={(e) => setForm({ ...form, durationHours: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                {DURATIONS.map((d) => <option key={d.h} value={d.h}>{lang === "ar" ? d.ar : d.en} ({d.h}h)</option>)}
              </select>
            </div>
            <DlgField label="Profile (RouterOS)" value={form.profile} onChange={(v) => setForm({ ...form, profile: v })} dir="ltr" placeholder={form.name || "مثل اسم الباقة"} />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("router")}</label>
              <select value={form.routerId} onChange={(e) => setForm({ ...form, routerId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "الوصف" : "Description"}</label>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white" />
            </div>
            <p className="col-span-2 text-[10px] leading-relaxed text-[#64748B]">
              {lang === "ar"
                ? "الاسم والبروفايل والسرعة تُكتب فعلياً على الراوتر (Hotspot Profile). السعر والمدة والحد وتفعيل الباقة بيانات محلية فقط لأن RouterOS لا يخزنها."
                : "Name, profile and speed are written to the router's Hotspot Profile. Price, validity, limit and active flag stay local (RouterOS has no such fields)."}
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={save} disabled={saving} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deletePkg} onOpenChange={(v) => !v && setDeletePkg(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] max-w-sm text-[#F1F5F9]">
          <DialogHeader><DialogTitle className="text-white">{lang === "ar" ? "تأكيد الحذف" : "Confirm deletion"}</DialogTitle></DialogHeader>
          <p className="text-xs text-[#8CA3C3]">{lang === "ar" ? `حذف الباقة «${deletePkg?.name}»؟` : `Delete "${deletePkg?.name}"?`}</p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeletePkg(null)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={remove} className="bg-[#EF4444] hover:bg-[#F87171] text-white font-bold">{t("delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#0B1428] border border-[#1B2946]/60 rounded-lg py-1.5">
      <div className="text-[9.5px] text-[#8CA3C3]">{label}</div>
      <div className="text-[11px] font-extrabold text-white num" dir="ltr">{value}</div>
    </div>
  );
}

export function DlgField({ label, value, onChange, dir, type = "text", placeholder }: { label: string; value: string; onChange: (v: string) => void; dir?: string; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className="text-xs text-[#8CA3C3] mb-1 block">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} dir={dir} type={type} placeholder={placeholder} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]" />
    </div>
  );
}
