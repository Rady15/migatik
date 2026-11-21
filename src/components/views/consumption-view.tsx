"use client";

/**
 * Unified consumption view: CURRENT (live RouterOS session/host counters +
 * last sampled rate) and TOTAL (all-time device daily totals / router user
 * counters) for every device and every Hotspot user, in one place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { RouterSelect } from "@/components/ui/router-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2, RefreshCw, Search, Radio, Download, Boxes, Users,
  ArrowDownToLine, ArrowUpFromLine, Database, Activity,
} from "lucide-react";
import type { ConsumptionDevice, ConsumptionUser } from "@/app/api/consumption/route";

interface Totals {
  devices: number;
  users: number;
  onlineDevices: number;
  activeSessions: number;
  currentDownMb: number;
  currentUpMb: number;
  totalDownMb: number;
  totalUpMb: number;
  userTotalMb: number;
}
interface Payload {
  devices: ConsumptionDevice[];
  users: ConsumptionUser[];
  totals: Totals;
  errors: { router: string; error: string }[];
  fetchedAt: string;
}

const EMPTY: Payload = {
  devices: [], users: [],
  totals: { devices: 0, users: 0, onlineDevices: 0, activeSessions: 0, currentDownMb: 0, currentUpMb: 0, totalDownMb: 0, totalUpMb: 0, userTotalMb: 0 },
  errors: [], fetchedAt: "",
};

const POLL_MS = 10000;

export function ConsumptionView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [routerId, setRouterId] = useState("all");
  const [tab, setTab] = useState<"devices" | "users">("devices");
  const [data, setData] = useState<Payload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api<Payload>(`/api/consumption?routerId=${routerId}&_=${Date.now()}`);
      setData(res);
    } catch (e) {
      if (!silent) setToast({ msg: (e as Error).message, ok: false });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [routerId]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(true);
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const s = search.trim().toLowerCase();
  const deviceRows = useMemo(() => data.devices
    .filter((d) => !connectedOnly || d.status === "online")
    .filter((d) => !s || d.name.toLowerCase().includes(s) || d.mac.toLowerCase().includes(s) ||
      (d.ip ?? "").includes(s) || d.routerName.toLowerCase().includes(s)),
  [data.devices, s, connectedOnly]);
  const userRows = useMemo(() => data.users
    .filter((u) => !connectedOnly || u.active)
    .filter((u) => !s || u.username.toLowerCase().includes(s) || (u.fullName ?? "").toLowerCase().includes(s) ||
      u.routerName.toLowerCase().includes(s)),
  [data.users, s, connectedOnly]);

  const updated = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString(ar ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  const exportCsv = () => {
    const isDev = tab === "devices";
    const head = isDev
      ? ["Device", "MAC", "IP", "Router", "Status", "Current down (MB)", "Current up (MB)", "Rate down (Mbps)", "Rate up (Mbps)", "Total down (MB)", "Total up (MB)", "Total (MB)"]
      : ["User", "Name", "Router", "Status", "Active", "Current down (MB)", "Current up (MB)", "Uptime (s)", "Total (MB)", "Limit (MB)"];
    const rows = isDev
      ? deviceRows.map((d) => [d.name, d.mac, d.ip ?? "", d.routerName, d.status, d.currentDownMb, d.currentUpMb,
          d.rateDownMbps.toFixed(3), d.rateUpMbps.toFixed(3), d.totalDownMb.toFixed(2), d.totalUpMb.toFixed(2), d.totalMb.toFixed(2)])
      : userRows.map((u) => [u.username, u.fullName ?? "", u.routerName, u.status, u.active ? "yes" : "no",
          u.currentDownMb, u.currentUpMb, u.currentSec, u.totalMb.toFixed(2), u.dataLimitMb ?? ""]);
    const csv = "\uFEFF" + [head, ...rows].map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `consumption-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-extrabold text-white flex items-center gap-2">
          <Activity className="w-4.5 h-4.5 text-[#22D3EE]" />
          {ar ? "الاستهلاك الحالي والجمالي" : "Current & Total Consumption"}
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 px-2.5 py-1 text-[10.5px] font-bold text-emerald-300">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          {ar ? "لحظي" : "LIVE"}
        </span>
        <span className="text-[10px] text-[#64748B]" dir="ltr">{updated}</span>
        <RouterSelect value={routerId} onChange={setRouterId} className="w-44" />
        <div className="relative flex-1 min-w-[150px] max-w-[240px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={ar ? "بحث بالاسم / MAC / IP…" : "Search name / MAC / IP…"}
            className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Checkbox checked={connectedOnly} onCheckedChange={(v) => setConnectedOnly(v === true)} />
          <span className="text-[10.5px] text-[#8CA3C3]">{ar ? "المتصلون فقط" : "Connected only"}</span>
        </label>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => void load()}>
          <RefreshCw className={`w-3.5 h-3.5 me-1 ${loading ? "animate-spin" : ""}`} />{ar ? "تحديث" : "Refresh"}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={exportCsv}>
          <Download className="w-3.5 h-3.5 me-1" />CSV
        </Button>
      </div>

      {toast && (
        <Alert className={`!py-2 ${toast.ok ? "border-emerald-700/50 bg-emerald-950/30" : "border-red-800/50 bg-red-950/30"}`}>
          <AlertDescription className={`text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">{toast.msg}</AlertDescription>
        </Alert>
      )}
      {data.errors.length > 0 && (
        <Alert className="!py-2 border-amber-800/50 bg-amber-950/20">
          <AlertDescription className="text-[11.5px] text-amber-300" dir="auto">
            {data.errors.map((e) => `${e.router}: ${e.error}`).join(" · ")}
          </AlertDescription>
        </Alert>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Tile icon={<Radio className="w-4 h-4" />} label={ar ? "جلسات متصلة الآن" : "Active sessions now"}
          value={fmtNum(data.totals.activeSessions)} tone="emerald" />
        <Tile icon={<Activity className="w-4 h-4" />} label={ar ? "استهلاك الجلسات الحالية" : "Current sessions usage"}
          value={`${fmtMb(data.totals.currentDownMb)} ↓ / ${fmtMb(data.totals.currentUpMb)} ↑`} tone="sky" />
        <Tile icon={<Database className="w-4 h-4" />} label={ar ? "إجمالي الأجهزة" : "Devices all-time"}
          value={`${fmtMb(data.totals.totalDownMb)} ↓ / ${fmtMb(data.totals.totalUpMb)} ↑`} tone="violet" />
        <Tile icon={<Users className="w-4 h-4" />} label={ar ? "إجمالي المستخدمين" : "Users all-time"}
          value={fmtMb(data.totals.userTotalMb)} tone="amber" />
      </div>
      <div className="text-[9.5px] text-[#64748B]" dir="auto">
        {ar
          ? "الحالية = عدّادات الجلسة/الجهاز المفتوحة الآن على الراوتر · الآني = آخر عيّنة مزامنة · الإجمالي = تراكمي (الأجهزة من مجاميع يومية، والمستخدمون من عدّادات الراوتر)."
          : "Current = live open session/host counters · Rate = last sync sample · Total = cumulative (devices from daily rollups, users from router counters)."}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "devices" | "users")}>
        <TabsList className="bg-[#111C30]/70 p-1 h-auto gap-1">
          <TabsTrigger value="devices" className="text-[11px] h-7 gap-1.5">
            <Boxes className="w-3.5 h-3.5" />{ar ? "الأجهزة" : "Devices"} <span className="num opacity-70">({deviceRows.length})</span>
          </TabsTrigger>
          <TabsTrigger value="users" className="text-[11px] h-7 gap-1.5">
            <Users className="w-3.5 h-3.5" />{ar ? "المستخدمون" : "Users"} <span className="num opacity-70">({userRows.length})</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="panel overflow-hidden">
        <div className="overflow-auto max-h-[560px]">
          <table className="w-full text-[11.5px]">
            <thead className="bg-[#111C30] sticky top-0 z-10">
              <tr className="text-[#8CA3C3]">
                {tab === "devices" ? (
                  <>
                    <Th>{ar ? "الجهاز" : "Device"}</Th><Th>MAC / IP</Th><Th>{ar ? "السيرفر" : "Router"}</Th>
                    <Th>{ar ? "الحالة" : "Status"}</Th>
                    <Th>{ar ? "الحالية ↓ / ↑" : "Current ↓ / ↑"}</Th>
                    <Th>{ar ? "الآني ↓ / ↑" : "Rate ↓ / ↑"}</Th>
                    <Th>{ar ? "الإجمالي ↓ / ↑" : "Total ↓ / ↑"}</Th>
                    <Th>{ar ? "المجموع" : "All-time"}</Th>
                  </>
                ) : (
                  <>
                    <Th>{ar ? "المستخدم" : "User"}</Th><Th>{ar ? "الاسم" : "Name"}</Th><Th>{ar ? "السيرفر" : "Router"}</Th>
                    <Th>{ar ? "الحالة" : "Status"}</Th>
                    <Th>{ar ? "الحالية ↓ / ↑" : "Current ↓ / ↑"}</Th>
                    <Th>{ar ? "المدة" : "Uptime"}</Th>
                    <Th>{ar ? "الإجمالي" : "All-time"}</Th>
                    <Th>{ar ? "الحد" : "Limit"}</Th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="text-[#E2E8F0]">
              {loading && (tab === "devices" ? deviceRows.length : userRows.length) === 0 && (
                <tr><td colSpan={8} className="text-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[#1685FF] mx-auto" /></td></tr>
              )}
              {!loading && (tab === "devices" ? deviceRows.length : userRows.length) === 0 && (
                <tr><td colSpan={8} className="text-center py-10 text-[#64748B] text-[11px]" dir="auto">
                  {ar ? "لا توجد بيانات مطابقة" : "No matching data"}
                </td></tr>
              )}

              {tab === "devices" && deviceRows.map((d) => (
                <tr key={d.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  <Td><span className="font-bold text-[#E2E8F0]">{d.name}</span>
                    <span className="block text-[9px] text-[#64748B] num" dir="ltr">{d.connectionType}</span></Td>
                  <Td mono>{d.mac}<span className="block text-[#64748B]">{d.ip ?? "—"}</span></Td>
                  <Td>{d.routerName}</Td>
                  <Td><StatusBadge status={d.status} ar={ar} live={d.currentKind !== null} /></Td>
                  <Td mono>{d.currentKind
                    ? <><span className="text-sky-300">{fmtMb(d.currentDownMb)} ↓</span> / <span className="text-violet-300">{fmtMb(d.currentUpMb)} ↑</span></>
                    : <span className="text-[#64748B]">—</span>}</Td>
                  <Td mono title={d.rateAt && Date.now() - new Date(d.rateAt).getTime() > 300000
                    ? (ar ? "عيّنة قديمة — المزامنة لم تعمل مؤخراً" : "Stale sample — sync has not run recently")
                    : (ar ? "آخر عيّنة مزامنة" : "Last sync sample")}>
                    {d.rateAt && Date.now() - new Date(d.rateAt).getTime() > 300000
                      ? <span className="text-[#64748B]">{d.rateDownMbps.toFixed(2)} / {d.rateUpMbps.toFixed(2)} Mbps *</span>
                      : <><span className="text-sky-300">{d.rateDownMbps.toFixed(2)}</span> / <span className="text-violet-300">{d.rateUpMbps.toFixed(2)}</span> Mbps</>}
                  </Td>
                  <Td mono><span className="text-sky-300">{fmtMb(d.totalDownMb)} ↓</span> / <span className="text-violet-300">{fmtMb(d.totalUpMb)} ↑</span></Td>
                  <Td mono><span className="font-bold text-emerald-300">{fmtMb(d.totalMb)}</span></Td>
                </tr>
              ))}

              {tab === "users" && userRows.map((u) => (
                <tr key={u.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  <Td><span className="font-bold text-[#67E8F9]" dir="auto">{u.username}</span>
                    <span className="block text-[9px] text-[#64748B]" dir="ltr">{u.profile}</span></Td>
                  <Td>{u.fullName ?? "—"}</Td>
                  <Td>{u.routerName}</Td>
                  <Td><StatusBadge status={u.active ? "online" : u.status} ar={ar} live={u.active} /></Td>
                  <Td mono>{u.active
                    ? <><span className="text-sky-300">{fmtMb(u.currentDownMb)} ↓</span> / <span className="text-violet-300">{fmtMb(u.currentUpMb)} ↑</span></>
                    : <span className="text-[#64748B]">—</span>}</Td>
                  <Td mono>{u.active ? duration(u.currentSec) : "—"}</Td>
                  <Td mono><span className="font-bold text-emerald-300">{fmtMb(u.totalMb)}</span></Td>
                  <Td mono>{u.dataLimitMb != null ? fmtMb(u.dataLimitMb) : "∞"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-[#111C30] px-3 py-1.5 text-[10px] text-[#64748B]">
          {fmtNum(tab === "devices" ? deviceRows.length : userRows.length)} {ar ? "صف" : "rows"} · {ar ? "تحديث تلقائي كل 10 ثوانٍ" : "auto-refresh every 10s"}
        </div>
      </div>
    </div>
  );
}

function fmtMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "0 B";
  if (mb >= 1048576) return `${(mb / 1048576).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(mb * 1024).toFixed(0)} KB`;
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function Tile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: "emerald" | "sky" | "violet" | "amber" }) {
  const cls = {
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    sky: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 flex items-center gap-2.5 min-w-0 ${cls}`}>
      <div className="shrink-0 opacity-90">{icon}</div>
      <div className="min-w-0">
        <div className="text-[13px] leading-5 font-extrabold num whitespace-nowrap" dir="ltr">{value}</div>
        <div className="text-[9.5px] font-bold opacity-80 truncate" dir="auto">{label}</div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-start px-2.5 py-2 font-bold text-[10.5px] whitespace-nowrap">{children}</th>;
}

function Td({ children, mono, title }: { children?: React.ReactNode; mono?: boolean; title?: string }) {
  return <td title={title} className="px-2.5 py-1.5 whitespace-nowrap"><span className={mono ? "num" : ""} dir={mono ? "ltr" : "auto"}>{children}</span></td>;
}

function StatusBadge({ status, ar, live }: { status: string; ar: boolean; live: boolean }) {
  const map: Record<string, [string, string]> = {
    online: ["bg-emerald-600", ar ? "متصل" : "online"],
    idle: ["bg-sky-600", ar ? "خامل" : "idle"],
    hotspot: ["bg-emerald-600", ar ? "متصل" : "online"],
    expired: ["bg-amber-600", ar ? "منتهي" : "expired"],
    suspended: ["bg-red-600", ar ? "موقوف" : "suspended"],
    offline: ["bg-[#475569]", ar ? "غير متصل" : "offline"],
  };
  const [bg, label] = map[status] ?? ["bg-[#475569]", status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ${bg} text-white text-[9px] font-bold px-1.5 py-0.5`} dir="ltr">
      {live && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />}{label}
    </span>
  );
}
