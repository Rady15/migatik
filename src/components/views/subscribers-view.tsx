"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum, fmtMoney, fmtDateTime } from "@/lib/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { StatusPill } from "./hotspot-users-view";
import { DlgField } from "./packages-view";
import { Plus, ContactRound, Loader2, RefreshCw, Pause, Play, Ban, ArrowLeftRight, X } from "lucide-react";

interface Sub {
  id: string; code: string; name: string; phone: string | null; email: string | null;
  accountType: string; username: string | null; status: string; balance: number;
  autoRenew: boolean; expiresAt: string | null; createdAt: string;
  macAddresses: string[];
  package?: { id: string; name: string; price: number } | null;
  packageName?: string | null;
  router?: { id: string; name: string; status: string } | null;
  branch?: { id: string; name: string } | null;
}
interface Profile {
  subscriber: Sub & { notes: string | null; address: string | null; activatedAt: string | null; suspendedAt: string | null; terminatedAt: string | null };
  devices: { id: string; macAddress: string; ipAddress: string | null; hostname: string | null; customName: string | null; status: string; connectionType: string; interfaceName: string | null; vlanId: number | null; manufacturer: string | null; lastSeen: string | null }[];
  sessions: { id: string; username: string; ip: string | null; startedAt: string; endedAt: string | null; durationSec: number; downloadMb: number; uploadMb: number; status: string }[];
  payments: { id: string; amount: number; method: string; createdAt: string }[];
  invoices: { id: string; number: string; total: number; status: string; createdAt: string }[];
  vouchers: { id: string; serial: string; username: string; status: string }[];
  events: { id: string; type: string; detail: string | null; actor: string | null; createdAt: string }[];
  transactions: { id: string; type: string; amount: number; reference: string | null; createdAt: string }[];
  subscriptions: { id: string; cycle: string; amount: number; active: boolean; nextRunAt: string }[];
  usage: { daily: { day: string; downMb: number; upMb: number; device: { macAddress: string } }[]; totalDownloadMb: number; totalUploadMb: number };
  finance: { paidTotal: number; balance: number };
  ipHistory: { id: string; ipAddress: string; interface: string | null; lastSeen: string }[];
}
interface Pkg { id: string; name: string; price: number }
interface Rtr { id: string; name: string; status: string }
interface Br { id: string; name: string }

const STATUS_LABELS: Record<string, { ar: string; cls: string }> = {
  registered: { ar: "مُسجل", cls: "bg-slate-500/20 text-slate-300" },
  active: { ar: "نشط", cls: "bg-emerald-500/20 text-emerald-300" },
  suspended: { ar: "معلّق", cls: "bg-amber-500/20 text-amber-300" },
  expired: { ar: "منتهي", cls: "bg-red-500/20 text-red-300" },
  terminated: { ar: "منتهي نهائياً", cls: "bg-red-900/40 text-red-300" },
};

const EVENT_LABELS: Record<string, string> = {
  registered: "تسجيل", activated: "تفعيل", renewed: "تجديد", suspended: "تعليق",
  reactivated: "إعادة تفعيل", package_migrated: "ترحيل باقة", terminated: "إنهاء",
  router_sync_ok: "مزامنة سيرفر ✓", router_sync_error: "خطأ مزامنة سيرفر",
};

export function SubscribersView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [data, setData] = useState<{ total: number; subscribers: Sub[]; kpi: Record<string, number> } | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [routers, setRouters] = useState<Rtr[]>([]);
  const [branches, setBranches] = useState<Br[]>([]);
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [routerId, setRouterId] = useState("all");
  const [page, setPage] = useState(1);
  const [genOpen, setGenOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", username: "", routerId: "", packageId: "", branchId: "", accountType: "hotspot", macAddresses: "", autoRenew: false });
  const [creating, setCreating] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [acting, setActing] = useState("");
  const [migratePkg, setMigratePkg] = useState("");
  const pageSize = 15;

  const load = useCallback(() => {
    api<{ total: number; subscribers: Sub[]; kpi: Record<string, number> }>(
      `/api/subscribers?search=${encodeURIComponent(search)}&status=${statusF}&routerId=${routerId}&page=${page}&pageSize=${pageSize}`,
    ).then(setData).catch((e) => toast.error((e as Error).message));
  }, [search, statusF, routerId, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ packages: Pkg[] }>("/api/packages").then((d) => setPkgs(d.packages)).catch(() => {});
    api<{ routers: Rtr[] }>("/api/routers").then((d) => setRouters(d.routers)).catch(() => {});
    api<{ branches: Br[] }>("/api/branches").then((d) => setBranches(d.branches)).catch(() => {});
  }, []);

  async function create() {
    if (!form.name.trim()) { toast.error(ar ? "الاسم مطلوب" : "Name required"); return; }
    setCreating(true);
    try {
      await api("/api/subscribers", { method: "POST", json: { ...form, macAddresses: form.macAddresses || undefined } });
      toast.success(ar ? "تم تسجيل المشترك" : "Subscriber registered");
      setGenOpen(false);
      setForm({ name: "", phone: "", username: "", routerId: "", packageId: "", branchId: "", accountType: "hotspot", macAddresses: "", autoRenew: false });
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setCreating(false); }
  }

  async function openProfile(id: string) {
    setProfileLoading(true);
    api<Profile>(`/api/subscribers/${id}`).then(setProfile).catch((e) => toast.error((e as Error).message)).finally(() => setProfileLoading(false));
  }

  async function action(id: string, act: string, confirmNeeded = false) {
    if (confirmNeeded && !window.confirm(ar
      ? "سيتم فصل خدمة المشترك على السيرفر فعلياً — متابعة؟"
      : "The subscriber's service will be disconnected on the router — continue?")) return;
    setActing(act);
    try {
      const res = await api<{ ok: boolean; detail?: string }>(`/api/subscribers/${id}`, { method: "POST", json: { action: act, confirm: confirmNeeded, packageId: act === "migrate_package" ? migratePkg || undefined : undefined } });
      toast.success(res.detail || (ar ? "تم التنفيذ" : "Done"));
      const p = await api<Profile>(`/api/subscribers/${id}`);
      setProfile(p);
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setActing(""); }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{ar ? "المشتركون — ملف موحد" : "Subscribers — Unified Profiles"}</h1>
        <Button onClick={() => setGenOpen(true)} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
          <Plus className="w-4 h-4" /> {ar ? "تسجيل مشترك" : "Register subscriber"}
        </Button>
      </div>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          {(["registered", "active", "suspended", "expired", "terminated"] as const).map((st) => (
            <div key={st} className="panel p-3 flex items-center justify-between">
              <span className={`text-xs font-bold rounded px-1.5 py-0.5 ${STATUS_LABELS[st].cls}`}>{STATUS_LABELS[st].ar}</span>
              <span className="text-white font-extrabold text-base num" dir="ltr">{fmtNum(data.kpi[st] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={ar ? "بحث بالاسم/الكود/المستخدم/الهاتف/MAC" : "Search name/code/user/phone/MAC"} className="flex-1 min-w-[200px] max-w-sm bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]" />
        <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(1); }} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
          <option value="all">{ar ? "كل الحالات" : "All statuses"}</option>
          {Object.keys(STATUS_LABELS).map((s) => <option key={s} value={s}>{STATUS_LABELS[s].ar}</option>)}
        </select>
        <RouterSelect value={routerId} onChange={(v) => { setRouterId(v); setPage(1); }} className="w-48" />
        {data && <span className="text-[11px] text-[#8CA3C3] num">{fmtNum(data.total)}</span>}
      </div>

      {!data ? (
        <Skeleton className="h-72 rounded-xl bg-[#111C33]" />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="mt-table w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>{ar ? "الكود" : "Code"}</th>
                  <th>{ar ? "الاسم" : "Name"}</th>
                  <th>{ar ? "المستخدم" : "Username"}</th>
                  <th>{ar ? "الباقة" : "Package"}</th>
                  <th>{ar ? "السيرفر" : "Router"}</th>
                  <th>{ar ? "الرصيد" : "Balance"}</th>
                  <th>{ar ? "الحالة" : "Status"}</th>
                  <th>{ar ? "الانتهاء" : "Expires"}</th>
                </tr>
              </thead>
              <tbody>
                {data.subscribers.length === 0 && <tr><td colSpan={8} className="text-center text-[#64748B] py-8">{ar ? "لا يوجد مشتركون — سجّل أول مشترك" : "No subscribers yet"}</td></tr>}
                {data.subscribers.map((s) => (
                  <tr key={s.id} className="hover:bg-[#121E38]/70 transition-colors cursor-pointer" onClick={() => openProfile(s.id)}>
                    <td className="num text-[#8CA3C3]" dir="ltr">{s.code}</td>
                    <td className="font-bold text-[#E2E8F0]">{s.name}<div className="text-[10px] text-[#8CA3C3]" dir="ltr">{s.phone ?? ""}</div></td>
                    <td className="num text-[#CBD5E1]" dir="ltr">{s.username ?? "—"}</td>
                    <td className="text-[#CBD5E1]">{s.package?.name ?? s.packageName ?? "—"}</td>
                    <td className="text-[#CBD5E1]">{s.router?.name ?? "—"}</td>
                    <td className="num text-[#E2E8F0]" dir="ltr">{fmtMoney(s.balance)}</td>
                    <td><span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${STATUS_LABELS[s.status]?.cls ?? ""}`}>{STATUS_LABELS[s.status]?.ar ?? s.status}</span></td>
                    <td className="num text-[#8CA3C3]" dir="ltr">{s.expiresAt ? s.expiresAt.slice(0, 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#1B2946]">
            <span className="text-[11px] text-[#8CA3C3] num" dir="ltr">{page} / {totalPages}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="text-[#CBD5E1] text-xs">+ {ar ? "التالي" : "Next"}</Button>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} className="text-[#CBD5E1] text-xs">{ar ? "السابق" : "Prev"}</Button>
            </div>
          </div>
        </div>
      )}

      {/* register dialog */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white flex items-center gap-2"><ContactRound className="w-4 h-4 text-[#22D3EE]" /> {ar ? "تسجيل مشترك جديد" : "Register subscriber"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><DlgField label={ar ? "الاسم *" : "Name *"} value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></div>
            <DlgField label={ar ? "الهاتف" : "Phone"} value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} dir="ltr" />
            <DlgField label={ar ? "اسم المستخدم على السيرفر" : "Router username"} value={form.username} onChange={(v) => setForm({ ...form, username: v })} dir="ltr" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "السيرفر" : "Router"}</label>
              <select value={form.routerId} onChange={(e) => setForm({ ...form, routerId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "الباقة" : "Package"}</label>
              <select value={form.packageId} onChange={(e) => setForm({ ...form, packageId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name} — {fmtMoney(p.price)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "الفرع" : "Branch"}</label>
              <select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "نوع الحساب" : "Account type"}</label>
              <select value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="hotspot">Hotspot</option>
                <option value="pppoe">PPPoE</option>
                <option value="both">Hotspot + PPPoE</option>
              </select>
            </div>
            <div className="col-span-2"><DlgField label={ar ? "أجهزة مرتبطة (MAC مفصولة بفواصل)" : "Linked devices (MACs, comma-separated)"} value={form.macAddresses} onChange={(v) => setForm({ ...form, macAddresses: v })} dir="ltr" placeholder="AA:BB:CC:DD:EE:FF, 11:22:33:44:55:66" /></div>
            <label className="flex items-center gap-2 text-xs text-[#CBD5E1] col-span-2 cursor-pointer">
              <input type="checkbox" checked={form.autoRenew} onChange={(e) => setForm({ ...form, autoRenew: e.target.checked })} className="accent-[#1685FF]" />
              {ar ? "اشتراك متكرر (فوترة تلقائية لكل دورة)" : "Recurring subscription (auto-billing per cycle)"}
            </label>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setGenOpen(false)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={create} disabled={creating} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {ar ? "تسجيل" : "Register"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* unified profile drawer */}
      <Dialog open={!!profile || profileLoading} onOpenChange={(v) => { if (!v) { setProfile(null); setProfileLoading(false); } }}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-4xl max-h-[90vh] overflow-y-auto">
          {profileLoading || !profile ? (
            <Skeleton className="h-72 rounded-xl bg-[#111C33]" />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-white flex items-center gap-2 flex-wrap">
                  <ContactRound className="w-4 h-4 text-[#22D3EE]" />
                  {profile.subscriber.name}
                  <span className="text-[10px] num text-[#8CA3C3]" dir="ltr">{profile.subscriber.code}</span>
                  <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${STATUS_LABELS[profile.subscriber.status]?.cls}`}>{STATUS_LABELS[profile.subscriber.status]?.ar}</span>
                </DialogTitle>
              </DialogHeader>

              {/* lifecycle actions */}
              <div className="flex items-center gap-2 flex-wrap bg-[#0B1428] border border-[#24344F]/60 rounded-lg px-3 py-2">
                {profile.subscriber.status === "registered" && (
                  <Button size="sm" onClick={() => action(profile.subscriber.id, "activate")} disabled={!!acting} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs gap-1">{acting === "activate" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{ar ? "تفعيل" : "Activate"}</Button>
                )}
                {["active", "expired"].includes(profile.subscriber.status) && (
                  <Button size="sm" onClick={() => action(profile.subscriber.id, "renew")} disabled={!!acting} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white text-xs gap-1">{acting === "renew" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}{ar ? "تجديد" : "Renew"}</Button>
                )}
                {profile.subscriber.status === "active" && (
                  <Button size="sm" onClick={() => action(profile.subscriber.id, "suspend", true)} disabled={!!acting} className="bg-amber-600 hover:bg-amber-500 text-white text-xs gap-1">{acting === "suspend" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}{ar ? "تعليق (فصل على السيرفر)" : "Suspend (disconnects)"}</Button>
                )}
                {["suspended", "expired"].includes(profile.subscriber.status) && (
                  <Button size="sm" onClick={() => action(profile.subscriber.id, "reactivate")} disabled={!!acting} className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs gap-1">{acting === "reactivate" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}{ar ? "إعادة تفعيل" : "Reactivate"}</Button>
                )}
                <select value={migratePkg} onChange={(e) => setMigratePkg(e.target.value)} className="bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="">{ar ? "— اختر الباقة الجديدة —" : "— pick new package —"}</option>
                  {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <Button size="sm" onClick={() => { if (!migratePkg) { toast.error(ar ? "اختر الباقة الجديدة أولاً" : "Pick the new package first"); return; } action(profile.subscriber.id, "migrate_package"); }} disabled={!!acting} className="bg-[#24344F] hover:bg-[#2E4260] text-white text-xs gap-1"><ArrowLeftRight className="w-3 h-3" />{ar ? "ترحيل باقة" : "Migrate package"}</Button>
                {profile.subscriber.status !== "terminated" && (
                  <Button size="sm" onClick={() => action(profile.subscriber.id, "terminate", true)} disabled={!!acting} className="bg-red-900/60 hover:bg-red-800 text-red-200 text-xs gap-1"><Ban className="w-3 h-3" />{ar ? "إنهاء الحساب" : "Terminate"}</Button>
                )}
              </div>

              {/* KPI strip */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {[
                  [ar ? "الأجهزة المرتبطة" : "Devices", profile.devices.length],
                  [ar ? "إجمالي التحميل" : "Total down", `${(profile.usage.totalDownloadMb / 1024).toFixed(2)} GB`],
                  [ar ? "إجمالي الرفع" : "Total up", `${(profile.usage.totalUploadMb / 1024).toFixed(2)} GB`],
                  [ar ? "إجمالي المدفوع" : "Paid", fmtMoney(profile.finance.paidTotal)],
                  [ar ? "الرصيد الحالي" : "Balance", fmtMoney(profile.finance.balance)],
                ].map(([l, v], i) => (
                  <div key={i} className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-[#8CA3C3]">{l}</div>
                    <div className="text-xs font-extrabold text-white num" dir="ltr">{v}</div>
                  </div>
                ))}
              </div>

              {/* devices + sessions */}
              <div className="grid md:grid-cols-2 gap-3">
                <div className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-3">
                  <h3 className="text-xs font-extrabold text-white mb-2">{ar ? "الأجهزة المرتبطة" : "Linked devices"}</h3>
                  {profile.devices.length === 0 && <div className="text-[11px] text-[#64748B]">{ar ? "لا أجهزة مرتبطة — اربط MAC من التعديل" : "No linked devices"}</div>}
                  <div className="space-y-1.5">
                    {profile.devices.map((d) => (
                      <div key={d.id} className="flex items-center justify-between text-[11px]">
                        <span className="num text-[#E2E8F0]" dir="ltr">{d.macAddress}</span>
                        <span className="text-[#8CA3C3]" dir="ltr">{d.ipAddress ?? "—"} · {d.connectionType} · {d.status}</span>
                      </div>
                    ))}
                  </div>
                  <h3 className="text-xs font-extrabold text-white mt-3 mb-2">{ar ? "سجل عناوين IP" : "IP history"}</h3>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {profile.ipHistory.slice(0, 8).map((h) => (
                      <div key={h.id} className="flex items-center justify-between text-[11px]">
                        <span className="num text-[#CBD5E1]" dir="ltr">{h.ipAddress}</span>
                        <span className="text-[9.5px] text-[#64748B] num" dir="ltr">{h.lastSeen?.slice(0, 16)}</span>
                      </div>
                    ))}
                    {profile.ipHistory.length === 0 && <div className="text-[11px] text-[#64748B]">—</div>}
                  </div>
                </div>
                <div className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-3">
                  <h3 className="text-xs font-extrabold text-white mb-2">{ar ? "آخر الجلسات" : "Recent sessions"}</h3>
                  {profile.sessions.length === 0 && <div className="text-[11px] text-[#64748B]">—</div>}
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {profile.sessions.slice(0, 10).map((s) => (
                      <div key={s.id} className="flex items-center justify-between text-[11px]">
                        <span className="num text-[#E2E8F0]" dir="ltr">{s.ip ?? "—"}</span>
                        <span className="text-[9.5px] text-[#8CA3C3] num" dir="ltr">{s.startedAt.slice(0, 16)} · {(s.downloadMb / 1024).toFixed(1)}/{(s.uploadMb / 1024).toFixed(1)} GB · {s.status === "active" ? "نشطة" : "منتهية"}</span>
                      </div>
                    ))}
                  </div>
                  <h3 className="text-xs font-extrabold text-white mt-3 mb-2">{ar ? "الكروت المرتبطة" : "Vouchers"}</h3>
                  <div className="space-y-1">
                    {profile.vouchers.map((v) => (
                      <div key={v.id} className="flex items-center justify-between text-[11px]">
                        <span className="num text-[#E2E8F0]" dir="ltr">{v.username}</span>
                        <StatusPill status={v.status} lang={lang} />
                      </div>
                    ))}
                    {profile.vouchers.length === 0 && <div className="text-[11px] text-[#64748B]">—</div>}
                  </div>
                </div>
              </div>

              {/* finance + events */}
              <div className="grid md:grid-cols-2 gap-3">
                <div className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-3">
                  <h3 className="text-xs font-extrabold text-white mb-2">{ar ? "المدفوعات والفواتير" : "Payments & invoices"}</h3>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {profile.payments.map((p) => (
                      <div key={p.id} className="flex items-center justify-between text-[11px]">
                        <span className="text-emerald-300 font-bold num" dir="ltr">+{fmtMoney(p.amount)}</span>
                        <span className="text-[9.5px] text-[#64748B] num" dir="ltr">{p.method} · {p.createdAt.slice(0, 16)}</span>
                      </div>
                    ))}
                    {profile.invoices.map((iv) => (
                      <div key={iv.id} className="flex items-center justify-between text-[11px]">
                        <span className="text-[#CBD5E1] num" dir="ltr">{iv.number} — {fmtMoney(iv.total)}</span>
                        <StatusPill status={iv.status} lang={lang} />
                      </div>
                    ))}
                    {profile.payments.length === 0 && profile.invoices.length === 0 && <div className="text-[11px] text-[#64748B]">—</div>}
                  </div>
                  {profile.subscriptions.length > 0 && (
                    <>
                      <h3 className="text-xs font-extrabold text-white mt-3 mb-2">{ar ? "الاشتراك المتكرر" : "Recurring subscription"}</h3>
                      {profile.subscriptions.map((r) => (
                        <div key={r.id} className="text-[11px] text-[#CBD5E1]">
                          {r.cycle} · {fmtMoney(r.amount)} · {ar ? "التالي" : "next"}: <span className="num" dir="ltr">{r.nextRunAt.slice(0, 10)}</span> {r.active ? "✓" : "⏸"}
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <div className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-3">
                  <h3 className="text-xs font-extrabold text-white mb-2">{ar ? "سجل دورة الحياة" : "Lifecycle audit trail"}</h3>
                  <div className="space-y-1.5 max-h-52 overflow-y-auto">
                    {profile.events.map((ev) => (
                      <div key={ev.id} className="text-[11px] flex gap-2">
                        <span className={`font-bold shrink-0 ${ev.type === "router_sync_error" ? "text-red-300" : "text-[#8CA3C3]"}`}>{EVENT_LABELS[ev.type] ?? ev.type}</span>
                        <span className="text-[#CBD5E1] truncate" title={ev.detail ?? ""}>{ev.detail ?? ""}</span>
                        <span className="text-[9px] text-[#4C5F80] num shrink-0 ms-auto" dir="ltr">{fmtDateTime(ev.createdAt)}</span>
                      </div>
                    ))}
                    {profile.events.length === 0 && <div className="text-[11px] text-[#64748B]">—</div>}
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => { setProfile(null); }} className="text-[#CBD5E1]"><X className="w-4 h-4" /> {ar ? "إغلاق" : "Close"}</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
