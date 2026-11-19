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
import {
  Plus, Printer, Loader2, Layers, QrCode, X, EyeOff,
  RefreshCw, Play, ShoppingCart, Ban, Trash2, Wifi,
} from "lucide-react";

interface Voucher {
  id: string; serial: string; username: string; password: string; price: number; currency: string;
  status: string; routerSynced: boolean; syncError: string | null; createdAt: string;
  authMode: string; hiddenOnPrint: boolean;
  package?: { name: string; downloadMbps?: number; uploadMbps?: number; durationHours?: number } | null;
  router?: { name: string } | null; batch?: { name: string } | null;
}
interface Batch {
  id: string; name: string; count: number; syncedCount: number; status: string; price: number;
  createdAt: string; authMode: string; prefix: string;
  package?: { name: string } | null; router?: { name: string } | null;
}
interface Pkg { id: string; name: string; price: number; durationHours: number; downloadMbps: number; uploadMbps: number; profile: string }
interface Rtr { id: string; name: string; status: string }

const AUTH_MODE_OPTIONS = [
  { value: "user_pass", ar: "اسم مستخدم + كلمة مرور", en: "Username + Password" },
  { value: "pin", ar: "رمز PIN واحد (الرمز = اسم المستخدم = كلمة المرور)", en: "Single PIN (code = username = password)" },
  { value: "username_only", ar: "اسم المستخدم فقط — بدون كلمة مرور", en: "Username only — passwordless" },
  { value: "scratch", ar: "كلمة مرور مخفية خلف السكراتش", en: "Hidden scratch-off password" },
] as const;

const emptyGen = {
  name: "", routerId: "", packageId: "", prefix: "MK", count: "20",
  usernameLength: "6", passwordLength: "4", mode: "random", validityHours: "", notes: "",
  authMode: "user_pass", codeCharset: "alnum", hotspotServer: "", activationPolicy: "on_first_login",
};

export function VouchersView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [data, setData] = useState<{ total: number; vouchers: Voucher[]; batches: Batch[]; stats: { status: string; _count: number }[] } | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [routers, setRouters] = useState<Rtr[]>([]);
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [batchF, setBatchF] = useState("all");
  const [routerId, setRouterId] = useState("all");
  const [page, setPage] = useState(1);
  const [genOpen, setGenOpen] = useState(false);
  const [form, setForm] = useState(emptyGen);
  const [generating, setGenerating] = useState(false);
  const [printBatch, setPrintBatch] = useState<{ batchId: string; name: string; authMode?: string } | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[]; label: string; batchId?: string } | null>(null);

  const pageSize = 15;

  const load = useCallback(() => {
    api<{ total: number; vouchers: Voucher[]; batches: Batch[]; stats: { status: string; _count: number }[] }>(
      `/api/vouchers?search=${encodeURIComponent(search)}&status=${statusF}&batchId=${batchF}&routerId=${routerId}&page=${page}&pageSize=${pageSize}`,
    )
      .then(setData)
      .catch((e) => toast.error((e as Error).message));
  }, [search, statusF, batchF, routerId, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ packages: Pkg[] }>("/api/packages").then((d) => setPkgs(d.packages)).catch(() => {});
    api<{ routers: Rtr[] }>("/api/routers").then((d) => setRouters(d.routers)).catch(() => {});
  }, []);

  async function generate() {
    if (!form.routerId || !form.packageId) {
      toast.error(lang === "ar" ? "اختر السيرفر والباقة" : "Select router and package");
      return;
    }
    setGenerating(true);
    try {
      const res = await api<{ ok: boolean; synced: number; failed: number; message: string; batchId: string; passwordlessReady?: boolean | null; passwordlessWarning?: string }>(
        "/api/vouchers/generate", { method: "POST", json: { ...form, count: Number(form.count) } },
      );
      if (res.failed > 0 && res.synced === 0) {
        toast.warning(res.message);
      } else if (res.failed > 0) {
        toast.warning(res.message);
      } else if (res.passwordlessReady === false) {
        toast.warning(res.passwordlessWarning?.split("\n")[0] ?? res.message, { duration: 8000 });
      } else {
        toast.success(res.message);
      }
      setGenOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function runAction(action: string, ids: string[], opts?: { batchId?: string; confirm?: boolean }) {
    setActionBusy(`${action}:${ids.join(",")}`);
    try {
      const res = await api<{ ok: boolean; changed: number; failed: number; message: string }>(
        "/api/vouchers/actions",
        { method: "POST", json: { action, ids, ...(opts?.batchId ? { batchId: opts.batchId } : {}), confirm: opts?.confirm === true } },
      );
      if (res.ok) toast.success(res.message);
      else toast.warning(res.message);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActionBusy("");
    }
  }

  async function testLogin(v: Voucher) {
    setActionBusy(`test:${v.id}`);
    try {
      const res = await api<{ verdict: string; message?: string; note?: string; http?: { error?: string | null }; api?: { error?: string | null } }>(
        "/api/vouchers/hotspot-login-test",
        { method: "POST", json: { voucherId: v.id } },
      );
      if (res.verdict === "PASS") toast.success(lang === "ar" ? `الدخول نجح فعلياً: ${v.username}` : `Login verified: ${v.username}`);
      else toast.warning(`${lang === "ar" ? "فشل اختبار الدخول" : "Login test failed"}: ${res.http?.error ?? res.api?.error ?? res.note ?? ""}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActionBusy("");
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("cards")}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPrintBatch({ batchId: batchF !== "all" ? batchF : data?.batches[0]?.id ?? "", name: lang === "ar" ? "طباعة الكروت" : "Print Cards", authMode: data?.batches.find((b) => b.id === (batchF !== "all" ? batchF : data?.batches[0]?.id))?.authMode })} variant="ghost" className="text-[#CBD5E1] hover:bg-[#17243B] text-xs gap-1.5">
            <Printer className="w-3.5 h-3.5" /> {t("print")}
          </Button>
          <Button onClick={() => { setForm({ ...emptyGen, name: "" }); setGenOpen(true); }} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Plus className="w-4 h-4" /> {t("generateCards")}
          </Button>
        </div>
      </div>

      {/* stats strip */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {["unused", "sold", "activated", "expired"].map((st) => {
            const n = data.stats.find((s) => s.status === st)?._count ?? 0;
            const labels: Record<string, string> = { unused: "غير مستخدم", sold: "مباع", activated: "مُفعّل", expired: "منتهي" };
            const colors: Record<string, string> = { unused: "text-slate-300", sold: "text-blue-300", activated: "text-emerald-300", expired: "text-red-300" };
            return (
              <div key={st} className="panel p-3 flex items-center justify-between">
                <span className={`text-xs font-bold ${colors[st]}`}>{labels[st]}</span>
                <span className="text-white font-extrabold text-base num" dir="ltr">{fmtNum(n)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* batches */}
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <Layers className="w-4 h-4 text-[#1685FF]" />
          <h2 className="text-sm font-extrabold text-white">{t("batches")}</h2>
        </div>
        {data && data.batches.length === 0 && <div className="text-xs text-[#64748B] py-4 text-center">{t("noData")}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {data?.batches.slice(0, 6).map((b) => (
            <div key={b.id} className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#E2E8F0] truncate">{b.name}</span>
                <StatusPill status={b.status} lang={lang} />
              </div>
              <div className="flex items-center justify-between text-[10.5px] text-[#8CA3C3]">
                <span className="num">{fmtNum(b.count)} {lang === "ar" ? "كرت" : "cards"} · {fmtMoney(b.price)}</span>
                <button onClick={() => setPrintBatch({ batchId: b.id, name: b.name, authMode: b.authMode })} className="text-[#1685FF] hover:text-[#5CA9FF] flex items-center gap-1 font-bold">
                  <Printer className="w-3 h-3" /> {t("print")}
                </button>
              </div>
              <div className="flex items-center gap-3 pt-1 border-t border-[#1B2946]/60">
                <button
                  disabled={!!actionBusy}
                  onClick={() => runAction("sync_batch", [], { batchId: b.id })}
                  className="flex items-center gap-1 text-[10px] font-bold text-emerald-300/90 hover:text-emerald-200 disabled:opacity-40"
                  title={lang === "ar" ? "إعادة مزامنة كل كروت الدفعة على الراوتر" : "Re-sync every card in this batch on the router"}
                >
                  <RefreshCw className="w-3 h-3" /> {lang === "ar" ? "مزامنة" : "Sync"}
                </button>
                <button
                  disabled={!!actionBusy}
                  onClick={() => setDeleteTarget({ ids: [], label: b.name, batchId: b.id })}
                  className="flex items-center gap-1 text-[10px] font-bold text-red-300/90 hover:text-red-200 disabled:opacity-40"
                  title={lang === "ar" ? "حذف الدفعة وكروتة من الراوتر والقاعدة" : "Delete batch and its cards from router and DB"}
                >
                  <Trash2 className="w-3 h-3" /> {lang === "ar" ? "حذف" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t("search")} className="flex-1 min-w-[180px] max-w-xs bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]" />
        <select value={statusF} onChange={(e) => { setStatusF(e.target.value); setPage(1); }} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
          <option value="all">{lang === "ar" ? "كل الحالات" : "All statuses"}</option>
          {["unused", "sold", "activated", "expired", "pending_sync", "failed"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={batchF} onChange={(e) => { setBatchF(e.target.value); setPage(1); }} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white max-w-[220px]">
          <option value="all">{lang === "ar" ? "كل الدفعات" : "All batches"}</option>
          {data?.batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <RouterSelect value={routerId} onChange={(v) => { setRouterId(v); setBatchF("all"); setPage(1); }} className="w-48" />
        {data && <span className="text-[11px] text-[#8CA3C3] num">{fmtNum(data.total)}</span>}
      </div>

      {!data ? (
        <Skeleton className="h-72 rounded-xl bg-[#111C33]" />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="mt-table w-full min-w-[720px]">
              <thead>
                <tr>
                  <th>{t("serial")}</th>
                  <th>{t("username")}</th>
                  <th>{t("password")}</th>
                  <th>{lang === "ar" ? "الوضع" : "Mode"}</th>
                  <th>{t("package")}</th>
                  <th>{t("price")}</th>
                  <th>{t("status")}</th>
                  <th>{t("date")}</th>
                  <th>{lang === "ar" ? "إجراءات" : "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {data.vouchers.length === 0 && <tr><td colSpan={9} className="text-center text-[#64748B] py-8">{t("noData")}</td></tr>}
                {data.vouchers.map((v) => (
                  <tr key={v.id} className="hover:bg-[#121E38]/70 transition-colors">
                    <td className="num text-[#8CA3C3]" dir="ltr">{v.serial}</td>
                    <td className="font-bold text-[#E2E8F0] num" dir="ltr">{v.username}</td>
                    <td className="num text-[#CBD5E1]" dir="ltr">
                      {v.authMode === "username_only" ? <span className="text-[10px] text-[#8CA3C3]">—</span>
                        : v.hiddenOnPrint ? <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/90"><EyeOff className="w-3 h-3" /> مخفية</span>
                        : v.password}
                    </td>
                    <td className="text-[10px] text-[#8CA3C3]">{(AUTH_MODE_OPTIONS.find((m) => m.value === v.authMode) ?? { ar: v.authMode, en: v.authMode })[lang === "ar" ? "ar" : "en"]}</td>
                    <td className="text-[#CBD5E1]">{v.package?.name ?? "—"}</td>
                    <td className="num text-[#E2E8F0]" dir="ltr">{fmtMoney(v.price, v.currency)}</td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <StatusPill status={v.status} lang={lang} />
                        {v.syncError && <span title={v.syncError} className="text-[9px] text-red-400">!</span>}
                      </div>
                    </td>
                    <td className="num text-[#8CA3C3]" dir="ltr">{fmtDate(v.createdAt)}</td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        {v.status === "unused" && (
                          <button disabled={!!actionBusy} title={lang === "ar" ? "تحديد ك مباع" : "Mark sold"} onClick={() => runAction("mark_sold", [v.id])} className="text-sky-300/90 hover:text-sky-200 disabled:opacity-40">
                            <ShoppingCart className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {(v.status === "unused" || v.status === "sold" || v.status === "failed" || v.status === "pending_sync" || v.status === "expired") && (
                          <button disabled={!!actionBusy} title={v.status === "expired" ? (lang === "ar" ? "إعادة تفعيل الكرت" : "Reactivate card") : (lang === "ar" ? "تفعيل الكرت على الراوتر" : "Activate on router")} onClick={() => runAction(v.status === "expired" ? "reactivate" : "activate", [v.id])} className="text-emerald-300/90 hover:text-emerald-200 disabled:opacity-40">
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {v.status === "activated" && (
                          <button disabled={!!actionBusy} title={lang === "ar" ? "إنهاء صلاحية الكرت" : "Expire card"} onClick={() => runAction("expire", [v.id])} className="text-amber-300/90 hover:text-amber-200 disabled:opacity-40">
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button disabled={!!actionBusy} title={lang === "ar" ? "إعادة المزامنة مع الراوتر" : "Re-sync with router"} onClick={() => runAction("resync", [v.id])} className="text-[#1685FF] hover:text-[#5CA9FF] disabled:opacity-40">
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <button disabled={!!actionBusy} title={lang === "ar" ? "اختبار دخول حقيقي" : "Live login test"} onClick={() => testLogin(v)} className="text-violet-300/90 hover:text-violet-200 disabled:opacity-40">
                          <Wifi className="w-3.5 h-3.5" />
                        </button>
                        <button disabled={!!actionBusy} title={lang === "ar" ? "حذف الكرت من الراوتر والقاعدة" : "Delete card from router and DB"} onClick={() => setDeleteTarget({ ids: [v.id], label: v.username })} className="text-red-300/90 hover:text-red-200 disabled:opacity-40">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#1B2946]">
            <span className="text-[11px] text-[#8CA3C3] num" dir="ltr">{page} / {totalPages}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="text-[#CBD5E1] text-xs">+ {lang === "ar" ? "التالي" : "Next"}</Button>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} className="text-[#CBD5E1] text-xs">{lang === "ar" ? "السابق" : "Prev"}</Button>
            </div>
          </div>
        </div>
      )}

      {/* generate dialog */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-white flex items-center gap-2"><QrCode className="w-4 h-4 text-[#22D3EE]" /> {t("generateCards")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("router")}</label>
              <select value={form.routerId} onChange={(e) => setForm({ ...form, routerId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {routers.map((r) => <option key={r.id} value={r.id}>{r.name} {r.status !== "online" ? "(غير متصل)" : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("package")}</label>
              <select value={form.packageId} onChange={(e) => setForm({ ...form, packageId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.downloadMbps}/{p.uploadMbps}M · {p.durationHours}h · {fmtMoney(p.price)}</option>)}
              </select>
              {form.packageId && (() => {
                const p = pkgs.find((x) => x.id === form.packageId);
                return p ? (
                  <p className="mt-1 text-[10px] text-emerald-300/90 leading-relaxed">
                    {lang === "ar"
                      ? `سيُطبَّق على الراوتر: بروفايل «${p.profile}» بسرعة ${p.downloadMbps}/${p.uploadMbps}M وصلاحية ${p.durationHours} ساعة.`
                      : `Applied on router: profile "${p.profile}", ${p.downloadMbps}/${p.uploadMbps}M, validity ${p.durationHours}h.`}
                  </p>
                ) : null;
              })()}
            </div>
            <DlgField label={t("count")} value={form.count} onChange={(v) => setForm({ ...form, count: v })} dir="ltr" type="number" />
            <div>
              <DlgField label={lang === "ar" ? "البادئة (Prefix)" : "Prefix"} value={form.prefix} onChange={(v) => setForm({ ...form, prefix: v })} dir="ltr" placeholder="MK" />
              <p className="mt-1 text-[10px] text-[#64748B] leading-relaxed">
                {lang === "ar"
                  ? "البادئة تُضاف قبل كل كود (مثلاً MK123456). اتركها فارغة تماماً إذا أردت أن يكون الكود نفسه فقط بدون بادئة على الكارت."
                  : "The prefix is prepended to every code (e.g. MK123456). Leave it empty to print the bare code on the card."}
              </p>
            </div>
            <DlgField label={lang === "ar" ? "طول اسم المستخدم" : "Username length"} value={form.usernameLength} onChange={(v) => setForm({ ...form, usernameLength: v })} dir="ltr" type="number" />
            {form.authMode !== "pin" && form.authMode !== "username_only" && (
              <DlgField label={lang === "ar" ? "طول كلمة المرور" : "Password length"} value={form.passwordLength} onChange={(v) => setForm({ ...form, passwordLength: v })} dir="ltr" type="number" />
            )}
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "أحرف الرموز" : "Code charset"}</label>
              <select value={form.codeCharset} onChange={(e) => setForm({ ...form, codeCharset: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="alnum">{lang === "ar" ? "أحرف + أرقام" : "Alphanumeric"}</option>
                <option value="numeric">{lang === "ar" ? "أرقام فقط" : "Numeric"}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "أسلوب التوليد" : "Mode"}</label>
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="random">{lang === "ar" ? "عشوائي" : "Random"}</option>
                <option value="sequential">{lang === "ar" ? "تسلسلي" : "Sequential"}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "سياسة التفعيل" : "Activation policy"}</label>
              <select value={form.activationPolicy} onChange={(e) => setForm({ ...form, activationPolicy: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="on_first_login">{lang === "ar" ? "عند أول تسجيل دخول" : "On first login"}</option>
                <option value="immediate">{lang === "ar" ? "فوري عند البيع" : "Immediate at sale"}</option>
              </select>
            </div>
            <DlgField label={lang === "ar" ? "الصلاحية (ساعة)" : "Validity (hours)"} value={form.validityHours} onChange={(v) => setForm({ ...form, validityHours: v })} dir="ltr" type="number" placeholder="من الباقة" />
            <div className="col-span-2">
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "وضع المصادقة" : "Authentication mode"}</label>
              <select value={form.authMode} onChange={(e) => setForm({ ...form, authMode: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                {AUTH_MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{lang === "ar" ? m.ar : m.en}</option>)}
              </select>
              {form.authMode === "username_only" && (
                <div className="text-[10px] text-amber-300/90 mt-1 leading-relaxed">
                  {lang === "ar"
                    ? "يتطلب http-pap في login-by ببروفايل الهوتسبوت — تتحقق المنصة من الإعداد الفعلي على السيرفر وتنبيهك بالأمر المطلوب إن لم يكن مفعّلاً."
                    : "Requires http-pap in the hotspot profile login-by — the platform verifies the live router config and warns with the exact command if missing."}
                </div>
              )}
              {form.authMode === "pin" && (
                <div className="text-[10px] text-[#8CA3C3] mt-1">
                  {lang === "ar" ? "نفس الرمز يُستخدم كاسم مستخدم وكلمة مرور — يفضّل الأرقام فقط." : "The same code is used as both username and password — numeric recommended."}
                </div>
              )}
            </div>
            <div className="col-span-2">
              <DlgField label={lang === "ar" ? "Hotspot server (اختياري — يُتحقق منه فعلياً)" : "Hotspot server (optional — live-validated)"} value={form.hotspotServer} onChange={(v) => setForm({ ...form, hotspotServer: v })} dir="ltr" placeholder="hotspot1" />
            </div>
            <div className="col-span-2">
              <DlgField label={lang === "ar" ? "اسم الدفعة" : "Batch name"} value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            </div>
          </div>
          <div className="text-[10.5px] text-[#8CA3C3] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed">
            {lang === "ar"
              ? "تُنشأ الكروت أولاً في قاعدة البيانات ثم تُنشأ حسابات Hotspot حقيقية على السيرفر عبر RouterOS API ببروفايل الباقة المختارة وسرعتها. الكرت لا يُعتبر ناجحاً إلا بعد تأكيد السيرفر — وإلا يبقى بحالة «فشل المزامنة» مع تسجيل سبب الفشل."
              : "Cards are saved to the database, then real hotspot users are created on the router via the RouterOS API using the selected package's profile and speed. A card is only marked successful after the router confirms — otherwise it stays 'failed' with the error recorded."}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setGenOpen(false)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={generate} disabled={generating} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {generating ? (lang === "ar" ? "جارٍ التوليد..." : "Generating...") : t("generateCards")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-white">{lang === "ar" ? "تأكيد الحذف" : "Confirm deletion"}</DialogTitle></DialogHeader>
          <p className="text-xs text-[#8CA3C3] leading-relaxed">
            {lang === "ar"
              ? `سيتم حذف «${deleteTarget?.label}» من قاعدة البيانات ومن مستخدمي Hotspot على الراوتر. لا يمكن التراجع.`
              : `This will delete "${deleteTarget?.label}" from the database and from Hotspot users on the router. This cannot be undone.`}
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button
              disabled={!!actionBusy}
              onClick={async () => {
                if (!deleteTarget) return;
                await runAction(deleteTarget.batchId ? "delete_batch" : "delete", deleteTarget.ids, { batchId: deleteTarget.batchId, confirm: true });
                setDeleteTarget(null);
              }}
              className="bg-[#EF4444] hover:bg-[#F87171] text-white font-bold"
            >
              {actionBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} {t("delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* print dialog */}
      {printBatch && <PrintDialog batchId={printBatch.batchId} name={printBatch.name} batchAuthMode={printBatch.authMode} onClose={() => setPrintBatch(null)} />}
    </div>
  );
}

/* ============ PRINT ENGINE (mode-aware designer) ============ */

function PrintDialog({ batchId, name, batchAuthMode, onClose }: { batchId: string; name: string; batchAuthMode?: string; onClose: () => void }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [layout, setLayout] = useState<"a4" | "80mm" | "58mm">("a4");
  const [withQr, setWithQr] = useState(true);
  const [withSerial, setWithSerial] = useState(true);
  const [withPkg, setWithPkg] = useState(true);
  const [withSpeed, setWithSpeed] = useState(true);
  const [withValidity, setWithValidity] = useState(true);
  const [withPrice, setWithPrice] = useState(false);
  const [withInstructions, setWithInstructions] = useState(true);
  const [revealScratch, setRevealScratch] = useState(false); // admin proofing: reveal hidden scratch passwords
  const [revealed, setRevealed] = useState<Set<string>>(new Set()); // per-card reveal
  const [org, setOrg] = useState("");
  const [support, setSupport] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ settings: Record<string, string> }>("/api/settings").then((d) => {
      setOrg(d.settings.org_name ?? "MikroTik");
      setSupport(d.settings.org_phone ?? "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    if (!batchId) {
      const timer = setTimeout(() => { setVouchers([]); setLoading(false); }, 0);
      return () => clearTimeout(timer);
    }
    Promise.resolve().then(() => {
      if (!alive) return null;
      setLoading(true);
      // print=1 → up to 5000 cards for batch printing / PDF export
      return api<{ vouchers: Voucher[] }>(`/api/vouchers?batchId=${batchId}&page=1&pageSize=5000&print=1`);
    })
      .then((d) => { if (d && alive) setVouchers(d.vouchers); })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [batchId]);

  const authMode = batchAuthMode ?? vouchers[0]?.authMode ?? "user_pass";
  const cardWidth = layout === "a4" ? "calc(50% - 8px)" : layout === "80mm" ? "72mm" : "50mm";

  const qrUrl = (u: string, p: string) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(`http://wifi.login?u=${u}&p=${p}`)}`;

  const fmtValidity = (h?: number | null) => {
    if (!h) return "";
    if (h >= 720) return `${Math.round(h / 720)} ${lang === "ar" ? "شهر" : "mo"}`;
    if (h >= 168) return `${Math.round(h / 168)} ${lang === "ar" ? "أسبوع" : "wk"}`;
    if (h >= 24) return `${Math.round(h / 24)} ${lang === "ar" ? "يوم" : "d"}`;
    return `${h} ${lang === "ar" ? "ساعة" : "h"}`;
  };

  const revealCard = (id: string) => setRevealed((prev) => new Set(prev).add(id));

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Printer className="w-4 h-4 text-[#22D3EE]" /> {t("print")} — {name}
            <span className="text-[10px] font-bold text-[#8CA3C3] bg-[#0B1428] border border-[#24344F] rounded px-2 py-0.5" dir="ltr">
              {(AUTH_MODE_OPTIONS.find((m) => m.value === authMode) ?? { ar: authMode, en: authMode })[lang === "ar" ? "ar" : "en"]}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 flex-wrap no-print">
          {([["a4", "A4 — كرتين بالصف"], ["80mm", "حراري 80mm"], ["58mm", "حراري 58mm"]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setLayout(v)} className={`text-xs font-bold rounded-lg px-3 py-1.5 border ${layout === v ? "bg-[#1685FF] border-[#1685FF] text-white" : "bg-[#0B1428] border-[#24344F] text-[#CBD5E1]"}`}>
              {l}
            </button>
          ))}
          <Button onClick={() => window.print()} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Printer className="w-3.5 h-3.5" /> {lang === "ar" ? "طباعة / PDF" : "Print / PDF"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="text-[#FCA5A5] hover:bg-[#2A1520]"><X className="w-4 h-4" /></Button>
        </div>

        {/* designer toggles */}
        <div className="flex items-center gap-3 flex-wrap no-print text-[11px] text-[#CBD5E1] bg-[#0B1428] border border-[#24344F]/60 rounded-lg px-3 py-2">
          <span className="text-[#8CA3C3] font-bold">{lang === "ar" ? "عناصر التصميم:" : "Design elements:"}</span>
          {([
            ["logo", org !== "", () => setOrg(org ? "" : "MikroTik")],
            ["serial", withSerial, () => setWithSerial(!withSerial)],
            ["QR", withQr, () => setWithQr(!withQr)],
            [lang === "ar" ? "الباقة" : "Package", withPkg, () => setWithPkg(!withPkg)],
            [lang === "ar" ? "السرعة" : "Speed", withSpeed, () => setWithSpeed(!withSpeed)],
            [lang === "ar" ? "الصلاحية" : "Validity", withValidity, () => setWithValidity(!withValidity)],
            [lang === "ar" ? "السعر" : "Price", withPrice, () => setWithPrice(!withPrice)],
            [lang === "ar" ? "تعليمات" : "Instructions", withInstructions, () => setWithInstructions(!withInstructions)],
          ] as [string, boolean, () => void][]).map(([label, checked, toggle], i) => (
            <label key={i} className="flex items-center gap-1 cursor-pointer select-none">
              <input type="checkbox" checked={checked} onChange={toggle} className="accent-[#1685FF]" /> {label}
            </label>
          ))}
          <DlgField label="" value={org} onChange={setOrg} placeholder={lang === "ar" ? "الشعار (اسم الشركة)" : "Brand name"} />
          <DlgField label="" value={support} onChange={setSupport} placeholder={lang === "ar" ? "هاتف الدعم" : "Support phone"} />
        </div>

        {loading ? (
          <Skeleton className="h-64 rounded-xl bg-[#111C33]" />
        ) : vouchers.length === 0 ? (
          <div className="text-xs text-[#64748B] text-center py-8">{batchId ? t("noData") : (lang === "ar" ? "اختر دفعة من قائمة الدفعات أولاً" : "Select a batch first")}</div>
        ) : (
          <div className="print-area bg-white rounded-lg p-4 overflow-x-auto" dir="ltr">
            <div className="print-sheet flex flex-wrap gap-2 justify-center">
              {vouchers.map((v) => {
                const hiddenScratch = (v.hiddenOnPrint || v.authMode === "scratch") && !revealScratch && !revealed.has(v.id);
                return (
                  <div key={v.id} className="voucher-card" style={{ width: cardWidth }}>
                    {org && <div className="flex items-center justify-between">
                      <span className="vc-brand">{org}</span>
                      {withSerial && <span className="text-[9px] text-slate-500 num">{v.serial}</span>}
                    </div>}
                    <div className="text-center my-1">
                      {withPkg && <div className="text-[9px] text-slate-500 font-bold">{v.package?.name ?? ""}</div>}
                      {authMode === "pin" ? (
                        <>
                          <div className="text-[8px] text-slate-500 font-bold tracking-widest">{lang === "ar" ? "رمز الدخول PIN" : "LOGIN PIN"}</div>
                          <div className="vc-user" style={{ fontSize: layout === "a4" ? undefined : "15px" }}>{v.username}</div>
                          <div className="text-[7.5px] text-slate-400">{lang === "ar" ? "استخدم نفس الرمز كاسم مستخدم وكلمة مرور" : "Use the same code as username and password"}</div>
                        </>
                      ) : (
                        <>
                          <div className="vc-user">{v.username}</div>
                          {v.authMode === "username_only" ? (
                            <div className="text-[8px] text-slate-500 font-bold">{lang === "ar" ? "دخول باسم المستخدم فقط" : "Username-only login"}</div>
                          ) : hiddenScratch ? (
                            <button onClick={() => revealCard(v.id)} className="w-full mt-0.5 rounded bg-gradient-to-l from-slate-300 to-slate-200 text-slate-500 text-[9px] font-bold py-1.5 tracking-widest print:hidden" title={lang === "ar" ? "كلمة المرور مخفية خلف السكراتش" : "Password hidden behind scratch panel"}>
                              {lang === "ar" ? "كشط لكشف كلمة المرور" : "SCRATCH TO REVEAL"}
                            </button>
                          ) : (
                            <div className="vc-pass">{v.password}</div>
                          )}
                        </>
                      )}
                      {hiddenScratch && <div className="hidden print:block vc-pass">••••</div>}
                    </div>
                    {(withSpeed || withValidity) && (v.package?.downloadMbps || v.package?.durationHours) && (
                      <div className="text-center text-[8px] text-slate-500 num">
                        {withSpeed && v.package?.downloadMbps ? `${v.package.downloadMbps}${v.package?.uploadMbps ? `/${v.package.uploadMbps}` : ""} Mbps` : ""}
                        {withSpeed && withValidity && v.package?.downloadMbps && v.package?.durationHours ? " · " : ""}
                        {withValidity && fmtValidity(v.package?.durationHours)}
                      </div>
                    )}
                    {withPrice && <div className="text-center text-[8px] text-slate-600 font-bold num">{fmtMoney(v.price, v.currency)}</div>}
                    {withQr && (
                      <img src={qrUrl(v.username, v.authMode === "username_only" ? "" : v.password)} alt="QR" width={layout === "a4" ? 52 : 70} height={layout === "a4" ? 52 : 70} className="mx-auto" />
                    )}
                    {withInstructions && <div className="text-center text-[7.5px] text-slate-400 mt-0.5">{lang === "ar" ? "اتصل بشبكة الواي فاي ثم أدخل بيانات الدخول" : "Connect to the WiFi then enter the login credentials"}</div>}
                    {support && <div className="text-center text-[8.5px] text-slate-500 num" dir="ltr">{support}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[10px] text-[#64748B] no-print flex items-center justify-between gap-2 flex-wrap">
          <span>
            {lang === "ar"
              ? `عدد الكروت في المعاينة: ${vouchers.length} — استخدم «طباعة / PDF» لفتح نافذة الطباعة واختيار الحفظ كـ PDF أو الطباعة الحرارية.`
              : `${vouchers.length} cards in preview — use Print/PDF to open the browser print dialog (PDF or thermal).`}
          </span>
          {vouchers.some((v) => v.hiddenOnPrint || v.authMode === "scratch") && (
            <label className="flex items-center gap-1.5 cursor-pointer text-amber-300/90">
              <input type="checkbox" checked={revealScratch} onChange={(e) => setRevealScratch(e.target.checked)} className="accent-amber-400" />
              {lang === "ar" ? "كشف كلمات السكراتش (للمدار المطبوع للسكراتش)" : "Reveal scratch passwords (proofing)"}
            </label>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
