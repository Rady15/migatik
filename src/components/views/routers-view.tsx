"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Server, Wifi, MapPin, RefreshCw, Pencil, Trash2, Loader2,
  CircleCheck, CircleX, CircleHelp, Users as UsersIcon, Activity,
  Wand2, Copy, Check, Terminal,
} from "lucide-react";

interface RouterRow {
  id: string; name: string; host: string; apiPort: number; apiSslPort: number; useTls: boolean;
  apiUsername: string; location: string | null; category: string; connectionMethod: string; notes: string | null;
  status: string; statusMessage: string | null; lastCheckedAt: string | null; identity: string | null;
  version: string | null; boardName: string | null; uptime: string | null; cpuLoad: number | null;
  freeMemoryMb: number | null; totalMemoryMb: number | null; users: number; sessions: number;
}

const emptyForm = {
  id: "", name: "", host: "", apiPort: "8728", apiSslPort: "8729", useTls: false,
  apiUsername: "", apiPassword: "", location: "", category: "main", connectionMethod: "direct", notes: "",
};

export function RoutersView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [routers, setRouters] = useState<RouterRow[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // ---- one-command enrollment ----
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoForm, setAutoForm] = useState({ name: "", location: "", host: "", baseUrl: "", category: "main" });
  const [autoBusy, setAutoBusy] = useState(false);
  const [auto, setAuto] = useState<{ id: string; command: string; expiresAt: string } | null>(null);
  const [autoStatus, setAutoStatus] = useState("pending");
  const [autoCopied, setAutoCopied] = useState(false);

  const load = useCallback(() => {
    api<{ routers: RouterRow[] }>("/api/routers")
      .then((d) => setRouters(d.routers))
      .catch((e) => toast.error((e as Error).message));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  function openAdd() {
    setForm(emptyForm);
    setDialogOpen(true);
  }

  // ---------------------------------------------------------------------------
  // One-command enrollment: generate a RouterOS line, then watch for the router
  // to call back. Nothing is created until the device itself reports in.
  // ---------------------------------------------------------------------------
  function openAuto() {
    setAuto(null);
    setAutoStatus("pending");
    setAutoCopied(false);
    setAutoForm({
      name: `MikroTik ${(routers?.length ?? 0) + 1}`,
      location: routers?.length ? "" : "",
      host: "",
      baseUrl: typeof window !== "undefined" ? window.location.origin : "",
      category: "main",
    });
    setAutoOpen(true);
  }

  async function generateAuto() {
    if (!autoForm.name.trim()) {
      toast.error(lang === "ar" ? "اسم السيرفر مطلوب" : "Router name is required");
      return;
    }
    setAutoBusy(true);
    try {
      const res = await api<{ id: string; command: string; expiresAt: string }>("/api/routers/enroll", {
        method: "POST",
        json: {
          name: autoForm.name.trim(),
          location: autoForm.location,
          host: autoForm.host.trim(),
          baseUrl: autoForm.baseUrl.trim(),
          category: autoForm.category,
        },
      });
      setAuto({ id: res.id, command: res.command, expiresAt: res.expiresAt });
      setAutoStatus("pending");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAutoBusy(false);
    }
  }

  async function cancelAuto() {
    if (auto && autoStatus === "pending") {
      await api(`/api/routers/enroll?id=${auto.id}`, { method: "DELETE" }).catch(() => {});
    }
    setAutoOpen(false);
    setAuto(null);
  }

  async function copyCommand() {
    if (!auto) return;
    try {
      await navigator.clipboard.writeText(auto.command);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = auto.command;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setAutoCopied(true);
    setTimeout(() => setAutoCopied(false), 2500);
  }

  useEffect(() => {
    if (!autoOpen || !auto) return;
    let stopped = false;
    const tick = async () => {
      try {
        const d = await api<{ enrollments: { id: string; status: string }[] }>("/api/routers/enroll");
        if (stopped) return;
        const row = d.enrollments.find((e) => e.id === auto.id);
        if (!row) return;
        setAutoStatus(row.status);
        if (row.status === "installed") {
          stopped = true;
          toast.success(lang === "ar" ? "تم ربط السيرفر تلقائياً ✓" : "Router connected automatically ✓");
          setAutoOpen(false);
          setAuto(null);
          load();
        }
      } catch {
        /* keep polling — transient network error */
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, auto?.id, load, lang]);

  function openEdit(r: RouterRow) {
    setForm({
      id: r.id, name: r.name, host: r.host, apiPort: String(r.apiPort), apiSslPort: String(r.apiSslPort),
      useTls: r.useTls, apiUsername: r.apiUsername, apiPassword: "", location: r.location ?? "",
      category: r.category, connectionMethod: r.connectionMethod, notes: r.notes ?? "",
    });
    setDialogOpen(true);
  }

  async function save() {
    if (!form.name || !form.host || !form.apiUsername) {
      toast.error(lang === "ar" ? "الاسم و IP ومستخدم API مطلوبة" : "Name, IP and API user are required");
      return;
    }
    setSaving(true);
    try {
      if (form.id) {
        await api(`/api/routers/${form.id}`, { method: "PATCH", json: form });
        toast.success(t("saved"));
      } else {
        await api("/api/routers", { method: "POST", json: form });
        toast.success(lang === "ar" ? "تم إضافة السيرفر — اختبر الاتصال الآن" : "Server added — test the connection now");
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function test(r: RouterRow) {
    setTestingId(r.id);
    try {
      const res = await api<{ ok: boolean; error?: string; latencyMs?: number; info?: { version?: string; uptime?: string } }>(
        `/api/routers/${r.id}/test`, { method: "POST", json: {} },
      );
      if (res.ok) {
        toast.success(`${t("testSuccess")} — ${r.name} (${res.latencyMs}ms, RouterOS ${res.info?.version ?? "?"})`);
      } else {
        toast.error(`${t("testFailed")}: ${res.error}`);
      }
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestingId(null);
    }
  }

  async function remove() {
    if (!deleteId) return;
    try {
      await api(`/api/routers/${deleteId}?id=${deleteId}`, { method: "DELETE" });
      toast.success(lang === "ar" ? "تم حذف السيرفر والمستخدمين المرتبطة" : "Server and associated users deleted");
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-extrabold text-white">{t("servers")}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={openAuto} className="bg-[#0E1A31] border border-[#22D3EE]/50 text-[#22D3EE] hover:bg-[#22D3EE]/10 hover:text-[#67E8F9] font-bold text-xs gap-1.5">
            <Wand2 className="w-4 h-4" /> {lang === "ar" ? "ربط تلقائي" : "Auto-connect"}
          </Button>
          <Button onClick={openAdd} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            <Plus className="w-4 h-4" /> {t("addRouter")}
          </Button>
        </div>
      </div>

      {!routers ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-44 rounded-xl bg-[#111C33]" />)}
        </div>
      ) : routers.length === 0 ? (
        <div className="panel p-10 text-center text-[#8CA3C3] text-sm">
          {lang === "ar" ? "لا توجد سيرفرات مسجلة — أضف أول سيرفر MikroTik" : "No servers yet — add your first MikroTik router"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {routers.map((r) => (
            <div key={r.id} className="panel p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-[#1685FF]/15 border border-[#1685FF]/30 flex items-center justify-center">
                    <Server className="w-5 h-5 text-[#1685FF]" />
                  </div>
                  <div>
                    <div className="text-white font-extrabold text-sm" dir="ltr">{r.name}</div>
                    <div className="text-[#8CA3C3] text-[11px] num flex items-center gap-1" dir="ltr">
                      <MapPin className="w-3 h-3" /> {r.host}
                    </div>
                  </div>
                </div>
                <StatusBadge status={r.status} title={r.statusMessage ?? r.status} />
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric label={t("cpu")} value={r.cpuLoad != null ? `${r.cpuLoad}%` : "—"} pct={r.cpuLoad} />
                <Metric
                  label={t("memory")}
                  value={r.freeMemoryMb != null && r.totalMemoryMb ? `${Math.round(((r.totalMemoryMb - r.freeMemoryMb) / r.totalMemoryMb) * 100)}%` : "—"}
                  pct={r.freeMemoryMb != null && r.totalMemoryMb ? ((r.totalMemoryMb - r.freeMemoryMb) / r.totalMemoryMb) * 100 : null}
                />
                <Metric
                  label={t("disk")}
                  value={r.freeMemoryMb != null && r.totalMemoryMb ? "—" : "—"}
                  pct={null}
                />
              </div>

              <div className="flex items-center gap-3 text-[11px] text-[#8CA3C3] flex-wrap">
                <span className="flex items-center gap-1"><Activity className="w-3 h-3 text-emerald-400" /> {r.sessions} {lang === "ar" ? "جلسة نشطة" : "sessions"}</span>
                <span className="flex items-center gap-1"><UsersIcon className="w-3 h-3 text-blue-400" /> {fmtNum(r.users)} {t("users")}</span>
                <span className="num" dir="ltr">{r.useTls ? `SSL:${r.apiSslPort}` : `API:${r.apiPort}`}</span>
                {r.version && <span className="num" dir="ltr">v{r.version}</span>}
                {r.uptime && <span className="num" dir="ltr">up {r.uptime}</span>}
              </div>

              {r.notes && <div className="text-[10.5px] text-[#64748B] border-t border-[#1B2946]/60 pt-2">{r.notes}</div>}

              <div className="flex items-center gap-2 border-t border-[#1B2946]/60 pt-3">
                <Button
                  size="sm" onClick={() => test(r)} disabled={testingId === r.id}
                  className="flex-1 bg-[#1685FF]/15 border border-[#1685FF]/40 text-[#5CA9FF] hover:bg-[#1685FF]/25 hover:text-[#7DB6FF] font-bold text-[11px] gap-1.5"
                >
                  {testingId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {t("testName")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(r)} className="text-[#CBD5E1] hover:text-white hover:bg-[#17243B]">
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteId(r.id)} className="text-[#FCA5A5] hover:text-red-400 hover:bg-[#2A1520]">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white">{form.id ? t("edit") : t("addRouter")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label={lang === "ar" ? "اسم السيرفر" : "Name"} value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field label={t("ipAddress")} value={form.host} onChange={(v) => setForm({ ...form, host: v })} dir="ltr" placeholder="192.168.1.1" />
            <Field label={t("apiPort")} value={form.apiPort} onChange={(v) => setForm({ ...form, apiPort: v })} dir="ltr" />
            <Field label={t("apiUser")} value={form.apiUsername} onChange={(v) => setForm({ ...form, apiUsername: v })} dir="ltr" placeholder="api-monitor" />
            <Field label={t("apiPass")} value={form.apiPassword} onChange={(v) => setForm({ ...form, apiPassword: v })} dir="ltr" type="password" placeholder={form.id ? "•••••• (بدون تغيير)" : "••••••"} />
            <Field label={t("location")} value={form.location} onChange={(v) => setForm({ ...form, location: v })} />
            <div className="col-span-2">
              <label className="flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer">
                <input type="checkbox" checked={form.useTls} onChange={(e) => setForm({ ...form, useTls: e.target.checked })} className="accent-[#1685FF]" />
                {t("useTls")}
              </label>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "الفئة" : "Category"}</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
                <option value="main">{lang === "ar" ? "رئيسي" : "Main"}</option>
                <option value="branch">{lang === "ar" ? "فرع" : "Branch"}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "طريقة الاتصال" : "Connection"}</label>
              <select value={form.connectionMethod} onChange={(e) => setForm({ ...form, connectionMethod: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
                <option value="direct">{lang === "ar" ? "API مباشر" : "Direct API"}</option>
                <option value="wireguard_agent">{lang === "ar" ? "وكيل WireGuard" : "WireGuard Agent"}</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-[#8CA3C3] mb-1 block">{t("notes")}</label>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white" />
            </div>
            <div className="col-span-2 text-[10px] text-[#64748B] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed">
              {lang === "ar"
                ? "بيانات API تُخزن مشفرة AES-256 ولا تُرسل للمتصفح أبداً. اختبار الاتصال يجرب اتصالاً حقيقياً بـ RouterOS API — لن يظهر «متصل» إلا إذا أكّد السيرفر تسجيل الدخول فعلياً."
                : "API credentials are AES-256 encrypted and never sent to the browser. Connection test performs a REAL RouterOS API login — 'online' is shown only after the device authenticates."}
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

      {/* one-command auto enrollment */}
      <Dialog open={autoOpen} onOpenChange={(v) => { if (!v) void cancelAuto(); }}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-[#22D3EE]" />
              {lang === "ar" ? "ربط تلقائي — أمر واحد داخل الميكروتك" : "Auto-connect — one line on the router"}
            </DialogTitle>
          </DialogHeader>

          {!auto ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label={lang === "ar" ? "اسم السيرفر" : "Router name"}
                  value={autoForm.name}
                  onChange={(v) => setAutoForm({ ...autoForm, name: v })}
                />
                <Field
                  label={lang === "ar" ? "الموقع (اختياري)" : "Location (optional)"}
                  value={autoForm.location}
                  onChange={(v) => setAutoForm({ ...autoForm, location: v })}
                />
                <Field
                  label={lang === "ar" ? "IP الراوتر (اختياري — يُكتشف تلقائياً)" : "Router IP (optional — auto-detected)"}
                  value={autoForm.host}
                  onChange={(v) => setAutoForm({ ...autoForm, host: v })}
                  dir="ltr"
                  placeholder="192.168.88.1"
                />
                <div>
                  <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "الفئة" : "Category"}</label>
                  <select
                    value={autoForm.category}
                    onChange={(e) => setAutoForm({ ...autoForm, category: e.target.value })}
                    className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="main">{lang === "ar" ? "رئيسي" : "Main"}</option>
                    <option value="branch">{lang === "ar" ? "فرع" : "Branch"}</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <Field
                    label={lang === "ar" ? "عنوان المنصة الذي يصل إليه الراوتر" : "Platform URL the router can reach"}
                    value={autoForm.baseUrl}
                    onChange={(v) => setAutoForm({ ...autoForm, baseUrl: v })}
                    dir="ltr"
                    placeholder="http://192.168.1.20:3000"
                  />
                </div>
              </div>

              <div className="text-[10px] text-[#8CA3C3] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed space-y-1">
                <div>
                  {lang === "ar"
                    ? "لن تُطلب منك بيانات دخول: الراوتر نفسه ينشئ مستخدم API مخصّصاً للمنصة ويُبلّغنا بعنوانه. لو فتحت اللوحة من localhost استخدم IP جهاز المنصة (مثال 192.168.1.20) حتى يصل إليه الراوتر."
                    : "No credentials are typed by hand: the router creates a dedicated API user and reports its address. If you opened the dashboard via localhost, use the platform machine's LAN IP so the router can reach it."}
                </div>
                <div className="text-[#64748B]" dir="ltr">
                  GET /api/onboard/install/&lt;token&gt; · valid 30 min · single use
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={cancelAuto} className="text-[#CBD5E1]">{t("cancel")}</Button>
                <Button onClick={generateAuto} disabled={autoBusy} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold gap-2">
                  {autoBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {lang === "ar" ? "توليد أمر الربط" : "Generate command"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <ol className="text-[11px] text-[#CBD5E1] space-y-1.5 list-decimal ps-4">
                <li>{lang === "ar" ? "افتح WebFig للراوتر ثم Terminal (New Terminal) — أو WinBox → New Terminal." : "Open WebFig → Terminal (or WinBox → New Terminal)."}</li>
                <li>{lang === "ar" ? "الصق الأمر التالي ثم Enter. سيُنشئ مستخدماً مخصصاً للوحة ويُبقي بياناتك كما هي." : "Paste the line below and press Enter. It creates a dedicated API user and leaves your config untouched."}</li>
                <li>{lang === "ar" ? "انتظر بضع ثوانٍ — سيظهر السيرفر هنا تلقائياً بحالة «متصل» بعد اختبار اتصال حقيقي." : "Wait a few seconds — the server appears here automatically once the API login is verified."}</li>
              </ol>

              <div className="relative">
                <pre
                  dir="ltr"
                  className="bg-[#050B16] border border-[#24344F] rounded-lg p-3 pe-10 text-[10.5px] leading-relaxed text-emerald-200 whitespace-pre-wrap break-all font-mono"
                >
                  {auto.command}
                </pre>
                <button
                  onClick={copyCommand}
                  className="absolute top-2 end-2 p-1.5 rounded-md bg-[#13223C] border border-[#24344F] text-[#8CA3C3] hover:text-white"
                  title={lang === "ar" ? "نسخ الأمر" : "Copy command"}
                >
                  {autoCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap text-[10.5px]">
                <span className={`inline-flex items-center gap-1.5 font-bold ${autoStatus === "expired" ? "text-amber-300" : "text-[#22D3EE]"}`}>
                  {autoStatus === "expired" ? (
                    <CircleX className="w-3.5 h-3.5" />
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )}
                  {autoStatus === "expired"
                    ? (lang === "ar" ? "انتهت صلاحية الأمر — ولّد أمراً جديداً" : "Command expired — generate a new one")
                    : (lang === "ar" ? "بانتظار استجابة الراوتر…" : "Waiting for the router…")}
                </span>
                <span className="text-[#64748B] num" dir="ltr">
                  {lang === "ar" ? "ينتهي" : "expires"} {new Date(auto.expiresAt).toLocaleTimeString()}
                </span>
              </div>

              <div className="text-[10px] text-[#64748B] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed">
                {lang === "ar"
                  ? "الأمر يحمّل سكربت الربط ثم يستورده: ينشئ المجموعة mtcm-api والمستخدم mtcm-cloud، يفعّل خدمة API، ويضيف نبضة كل 5 دقائق (mtcm-heartbeat). للحذف لاحقاً: /user remove mtcm-cloud و/system scheduler remove mtcm-heartbeat."
                  : "The line downloads and imports the enrollment script: it creates the mtcm-api group and mtcm-cloud user, enables the API service and adds a 5-minute heartbeat (mtcm-heartbeat). To undo: /user remove mtcm-cloud and /system scheduler remove mtcm-heartbeat."}
              </div>

              <div className="flex justify-between items-center gap-2">
                <span className="text-[10px] text-[#64748B] flex items-center gap-1">
                  <Terminal className="w-3 h-3" /> RouterOS 6.43+ · API 8728
                </span>
                <div className="flex gap-2">
                  {autoStatus === "expired" ? (
                    <Button onClick={() => { setAuto(null); setAutoStatus("pending"); }} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs">
                      {lang === "ar" ? "أمر جديد" : "New command"}
                    </Button>
                  ) : (
                    <Button variant="ghost" onClick={cancelAuto} className="text-[#CBD5E1] text-xs">{t("cancel")}</Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <Dialog open={!!deleteId} onOpenChange={(v) => !v && setDeleteId(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">{lang === "ar" ? "تأكيد الحذف" : "Confirm deletion"}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-[#8CA3C3] leading-relaxed">
            {lang === "ar" ? "سيتم حذف السيرفر نهائياً مع بياناته المرتبطة. هل تريد المتابعة؟" : "The server and its related data will be permanently deleted. Continue?"}
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setDeleteId(null)} className="text-[#CBD5E1]">{t("cancel")}</Button>
            <Button onClick={remove} className="bg-[#EF4444] hover:bg-[#F87171] text-white font-bold">{t("delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status, title }: { status: string; title?: string }) {
  const label = status === "online" ? "متصل" : status === "offline" ? "غير متصل" : "لم يُختبر";
  const cls =
    status === "online"
      ? "bg-emerald-500/15 border-emerald-500/35 text-emerald-300"
      : status === "offline"
        ? "bg-red-500/15 border-red-500/35 text-red-300"
        : "bg-slate-500/15 border-slate-500/35 text-slate-300";
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 border rounded-full px-2.5 py-1 text-[10.5px] font-bold ${cls}`}>
      {status === "online" ? <CircleCheck className="w-3 h-3" /> : status === "offline" ? <CircleX className="w-3 h-3" /> : <CircleHelp className="w-3 h-3" />}
      {label}
    </span>
  );
}

function Metric({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div className="bg-[#0B1428] border border-[#1B2946]/60 rounded-lg p-2">
      <div className="text-[10px] text-[#8CA3C3] mb-1">{label}</div>
      <div className="text-[11.5px] font-extrabold text-white num" dir="ltr">{value}</div>
      {pct != null && (
        <div className="h-1 bg-[#1B2946] rounded-full mt-1.5 overflow-hidden">
          <div
            className={`h-full rounded-full ${pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, dir, type = "text", placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; dir?: string; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs text-[#8CA3C3] mb-1 block">{label}</label>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} dir={dir} type={type} placeholder={placeholder}
        className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]"
      />
    </div>
  );
}
