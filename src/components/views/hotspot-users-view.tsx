"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum, fmtDuration, fmtDate } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import {
  Plus, Search, Pencil, Trash2, Loader2, PauseCircle, PlayCircle, Users, ChevronRight, ChevronLeft, Download,
} from "lucide-react";

interface UserRow {
  id: string; username: string; password: string; fullName: string | null; phone: string | null;
  status: string; dataUsedMb: number; uptimeSec: number; expiresAt: string | null;
  packageName: string; speed: number | null; routerName: string;
  packageId?: string | null; routerId?: string | null; profile?: string | null;
}

interface Pkg { id: string; name: string }
interface Rtr { id: string; name: string }

const emptyForm = { id: "", username: "", password: "", fullName: "", phone: "", packageId: "", routerId: "", status: "active", expiresAt: "" };

export function HotspotUsersView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [data, setData] = useState<{ total: number; page: number; users: UserRow[] } | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [routerId, setRouterId] = useState("all");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [routers, setRouters] = useState<Rtr[]>([]);
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const pageSize = 10;

  const load = useCallback(() => {
    api<{ total: number; page: number; users: UserRow[] }>(
      `/api/hotspot-users?search=${encodeURIComponent(search)}&status=${status}&routerId=${routerId}&page=${page}&pageSize=${pageSize}`,
    )
      .then(setData)
      .catch((e) => toast.error((e as Error).message));
  }, [search, status, routerId, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ packages: Pkg[] }>("/api/packages").then((d) => setPkgs(d.packages)).catch(() => {});
    api<{ routers: Rtr[] }>("/api/routers").then((d) => setRouters(d.routers)).catch(() => {});
  }, []);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  function openAdd() {
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(u: UserRow) {
    setForm({
      id: u.id, username: u.username, password: "", fullName: u.fullName ?? "", phone: u.phone ?? "",
      packageId: u.packageId ?? "", routerId: u.routerId ?? "", status: u.status,
      expiresAt: u.expiresAt ? u.expiresAt.slice(0, 10) : "",
    });
    setDialogOpen(true);
  }

  async function save() {
    if (!form.username || (!form.password && !form.id)) {
      toast.error(lang === "ar" ? "اسم المستخدم وكلمة المرور مطلوبان" : "Username and password required");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, password: form.password || undefined };
      if (form.id) {
        await api(`/api/hotspot-users/${form.id}`, { method: "PATCH", json: payload });
        toast.success(t("saved"));
      } else {
        await api("/api/hotspot-users", { method: "POST", json: payload });
        toast.success(t("saved"));
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(u: UserRow) {
    try {
      await api(`/api/hotspot-users/${u.id}`, { method: "PATCH", json: { status: u.status === "suspended" ? "active" : "suspended" } });
      toast.success(t("saved"));
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove() {
    if (!deleteUser) return;
    try {
      const res = await api<{ ok: boolean; routerRemoved?: boolean; routerNote?: string }>(
        `/api/hotspot-users/${deleteUser.id}`,
        { method: "DELETE" },
      );
      if (res.routerNote) toast.warning(res.routerNote, { duration: 7000 });
      else toast.success(t("deleted"));
      if (res.routerRemoved === false && !res.routerNote) {
        toast.info(lang === "ar" ? "أُزيل من التطبيق فقط — لم يكن موجوداً على الراوتر" : "Removed from the app only — it was not on the router");
      }
      setDeleteUser(null);
      load();
    } catch (e) {
      toast.error((e as Error).message, { duration: 8000 });
    }
  }

  function exportCsv() {
    if (!data) return;
    const rows = [
      ["username", "name", "phone", "package", "status", "dataUsedMb", "expiresAt"],
      ...data.users.map((u) => [u.username, u.fullName ?? "", u.phone ?? "", u.packageName, u.status, String(u.dataUsedMb), u.expiresAt ?? ""]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hotspot-users.csv";
    a.click();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("users")}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={exportCsv} variant="ghost" className="text-[#CBD5E1] hover:bg-[#17243B] text-xs gap-1.5">
            <Download className="w-3.5 h-3.5" /> {t("exportCsv")}
          </Button>
          <Button onClick={openAdd} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Plus className="w-4 h-4" /> {t("addUser")}
          </Button>
        </div>
      </div>

      {/* filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="w-4 h-4 text-[#64748B] absolute top-1/2 -translate-y-1/2 start-3" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t("search")}
            className="w-full bg-[#0E1A31] border border-[#24344F] rounded-lg ps-9 pe-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]"
          />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
          <option value="all">{lang === "ar" ? "كل الحالات" : "All"}</option>
          <option value="active">{t("active")}</option>
          <option value="suspended">{t("suspended")}</option>
          <option value="expired">{t("expired")}</option>
        </select>
        <RouterSelect value={routerId} onChange={(v) => { setRouterId(v); setPage(1); }} className="w-48" />
        {data && <span className="text-[11px] text-[#8CA3C3] num">{fmtNum(data.total)} {lang === "ar" ? "مستخدم" : "users"}</span>}
      </div>

      {!data ? (
        <Skeleton className="h-80 rounded-xl bg-[#111C33]" />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="mt-table w-full min-w-[760px]">
              <thead>
                <tr>
                  <th>{t("username")}</th>
                  <th>{t("package")}</th>
                  <th>{t("router")}</th>
                  <th>{t("status")}</th>
                  <th>{t("dataUsed")}</th>
                  <th>{t("expires")}</th>
                  <th className="w-28">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-[#64748B] py-8">{t("noData")}</td></tr>
                )}
                {data.users.map((u) => (
                  <tr key={u.id} className="hover:bg-[#121E38]/70 transition-colors">
                    <td>
                      <div className="font-bold text-[#E2E8F0]">{u.username}</div>
                      <div className="text-[10px] text-[#64748B]">{u.phone ?? u.fullName ?? ""}</div>
                    </td>
                    <td className="text-[#CBD5E1] num" dir="ltr">{u.packageName}</td>
                    <td className="text-[#CBD5E1]" dir="ltr">{u.routerName}</td>
                    <td>
                      <StatusPill status={u.status} lang={lang} />
                    </td>
                    <td className="num text-[#CBD5E1]" dir="ltr">{(u.dataUsedMb / 1024).toFixed(1)} GB</td>
                    <td className="num text-[#8CA3C3]" dir="ltr">{u.expiresAt ? fmtDate(u.expiresAt) : "—"}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" onClick={() => toggleStatus(u)} title={u.status === "suspended" ? t("activate") : t("suspend")} className="w-7 h-7 text-[#CBD5E1] hover:bg-[#17243B]">
                          {u.status === "suspended" ? <PlayCircle className="w-4 h-4 text-emerald-400" /> : <PauseCircle className="w-4 h-4 text-amber-400" />}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => openEdit(u)} className="w-7 h-7 text-[#CBD5E1] hover:bg-[#17243B]">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setDeleteUser(u)} className="w-7 h-7 text-[#FCA5A5] hover:bg-[#2A1520]">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#1B2946]">
            <span className="text-[11px] text-[#8CA3C3] num" dir="ltr">{page} / {totalPages}</span>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="w-7 h-7 text-[#CBD5E1]">
                <ChevronRight className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} className="w-7 h-7 text-[#CBD5E1]">
                <ChevronLeft className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* add/edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white">{form.id ? t("edit") : t("addUser")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("username")} value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
            <Field label={t("password")} value={form.password} onChange={(v) => setForm({ ...form, password: v })} dir="ltr" type="text" placeholder={form.id ? "بدون تغيير" : ""} />
            <Field label={t("fullName")} value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} />
            <Field label={t("phone")} value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} dir="ltr" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("package")}</label>
              <select value={form.packageId} onChange={(e) => setForm({ ...form, packageId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("router")}</label>
              <select value={form.routerId} onChange={(e) => setForm({ ...form, routerId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("status")}</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="active">{t("active")}</option>
                <option value="suspended">{t("suspended")}</option>
                <option value="expired">{t("expired")}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("expires")}</label>
              <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={save} disabled={saving} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t("save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* delete */}
      <Dialog open={!!deleteUser} onOpenChange={(v) => !v && setDeleteUser(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] max-w-sm text-[#F1F5F9]">
          <DialogHeader><DialogTitle className="text-white">{lang === "ar" ? "تأكيد الحذف" : "Confirm deletion"}</DialogTitle></DialogHeader>
          <p className="text-xs text-[#8CA3C3]">{lang === "ar" ? `سيتم حذف المستخدم «${deleteUser?.username}» نهائياً.` : `User "${deleteUser?.username}" will be deleted.`}</p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeleteUser(null)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={remove} className="bg-[#EF4444] hover:bg-[#F87171] text-white font-bold">{t("delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StatusPill({ status, lang }: { status: string; lang?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "نشط", cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
    suspended: { label: "معلق", cls: "bg-amber-500/15 border-amber-400/40 text-amber-300" },
    expired: { label: "منتهي", cls: "bg-red-500/15 border-red-400/40 text-red-300" },
    unused: { label: "غير مستخدم", cls: "bg-slate-500/15 border-slate-400/40 text-slate-300" },
    sold: { label: "مباع", cls: "bg-blue-500/15 border-blue-400/40 text-blue-300" },
    activated: { label: "مُفعّل", cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
    pending_sync: { label: "بانتظار المزامنة", cls: "bg-amber-500/15 border-amber-400/40 text-amber-300" },
    failed: { label: "فشل المزامنة", cls: "bg-red-500/15 border-red-400/40 text-red-300" },
    paid: { label: "مدفوعة", cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
    unpaid: { label: "غير مدفوعة", cls: "bg-amber-500/15 border-amber-400/40 text-amber-300" },
    overdue: { label: "متأخرة", cls: "bg-red-500/15 border-red-400/40 text-red-300" },
    draft: { label: "مسودة", cls: "bg-slate-500/15 border-slate-400/40 text-slate-300" },
    online: { label: "متصل", cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
    offline: { label: "غير متصل", cls: "bg-red-500/15 border-red-400/40 text-red-300" },
    untested: { label: "لم يُختبر", cls: "bg-slate-500/15 border-slate-400/40 text-slate-300" },
  };
  const it = map[status] ?? { label: status, cls: "bg-slate-500/15 border-slate-400/40 text-slate-300" };
  return (
    <span className={`inline-block border rounded-full px-2.5 py-0.5 text-[10.5px] font-bold ${it.cls}`}>
      {lang === "en" ? status : it.label}
    </span>
  );
}

function Field({ label, value, onChange, dir, type = "text", placeholder }: { label: string; value: string; onChange: (v: string) => void; dir?: string; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className="text-xs text-[#8CA3C3] mb-1 block">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} dir={dir} type={type} placeholder={placeholder} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]" />
    </div>
  );
}
