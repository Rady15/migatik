"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, RefreshCw, Search, Radio, WifiOff, Link2, Users, MonitorSmartphone, LogOut } from "lucide-react";

export type HotspotMode = "active" | "hosts" | "bindings";

interface LiveActive {
  id: string; routerId: string; routerName: string; user: string; address: string | null; mac: string | null;
  server: string | null; loginBy: string | null; uptime: string | null; durationSec: number; bytesIn: number; bytesOut: number; comment: string | null;
}
interface LiveHost {
  id: string; routerId: string; routerName: string; mac: string; address: string | null; toAddress: string | null;
  server: string | null; uptime: string | null; durationSec: number; bytesIn: number; bytesOut: number; authorized: boolean; bypassed: boolean;
}
interface LiveBinding {
  id: string; routerId: string; routerName: string; mac: string | null; address: string | null; toAddress: string | null;
  server: string | null; type: string; disabled: boolean; comment: string | null; connected: boolean;
}
interface LivePayload {
  active: LiveActive[];
  hosts: LiveHost[];
  bindings: LiveBinding[];
  counts: { active: number; hosts: number; bindings: number; connectedBindings: number };
  errors: { router: string; error: string }[];
  fetchedAt: string;
}

const EMPTY: LivePayload = {
  active: [], hosts: [], bindings: [],
  counts: { active: 0, hosts: 0, bindings: 0, connectedBindings: 0 },
  errors: [], fetchedAt: "",
};

const POLL_MS = 3000;

export function HotspotLivePanel({ mode, routerId, openDevice }: {
  mode: HotspotMode;
  routerId: string;
  openDevice?: (deviceId: string) => void;
}) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const ar = lang === "ar";

  const [data, setData] = useState<LivePayload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api<LivePayload>(`/api/hotspot/live?routerId=${routerId}&_=${Date.now()}`);
      setData(res);
    } catch (e) {
      if (!silent) setToast({ msg: (e as Error).message, ok: false });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [routerId]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(true);
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const disconnect = async (row: LiveActive) => {
    setBusyId(row.id);
    try {
      await api("/api/network/action", { json: { action: "hotspot_disconnect", routerId: row.routerId, mac: row.mac, username: row.user, confirm: true } });
      setToast({ msg: ar ? `تم فصل ${row.user}` : `Disconnected ${row.user}`, ok: true });
      await load(true);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setBusyId(null);
    }
  };

  const s = search.trim().toLowerCase();
  const activeRows = useMemo(() => data.active.filter((r) => !s ||
    r.user.toLowerCase().includes(s) || (r.mac ?? "").toLowerCase().includes(s) ||
    (r.address ?? "").toLowerCase().includes(s) || r.routerName.toLowerCase().includes(s)), [data.active, s]);
  const hostRows = useMemo(() => data.hosts.filter((r) => !s ||
    r.mac.toLowerCase().includes(s) || (r.address ?? "").toLowerCase().includes(s) ||
    (r.server ?? "").toLowerCase().includes(s) || r.routerName.toLowerCase().includes(s)), [data.hosts, s]);
  const bindingRows = useMemo(() => data.bindings
    .filter((r) => (connectedOnly ? r.connected && !r.disabled : true))
    .filter((r) => !s ||
      (r.mac ?? "").toLowerCase().includes(s) || (r.address ?? "").toLowerCase().includes(s) ||
      (r.comment ?? "").toLowerCase().includes(s) || r.routerName.toLowerCase().includes(s)),
    [data.bindings, s, connectedOnly]);

  const rowsCount = mode === "active" ? activeRows.length : mode === "hosts" ? hostRows.length : bindingRows.length;
  const updated = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString(ar ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div className="space-y-3">
      {/* live counters + toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 me-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 px-2.5 py-1 text-[10.5px] font-bold text-emerald-300">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            {ar ? "لحظي" : "LIVE"}
          </span>
          <span className="text-[10px] text-[#64748B]" dir="ltr">{updated}</span>
        </div>

        <CounterChip icon={<Users className="w-3.5 h-3.5" />} label={ar ? "جلسات Active" : "Active"} value={data.counts.active} tone="emerald" />
        <CounterChip icon={<MonitorSmartphone className="w-3.5 h-3.5" />} label={ar ? "Hosts مستضافة" : "Hosts"} value={data.counts.hosts} tone="sky" />
        <CounterChip icon={<Link2 className="w-3.5 h-3.5" />} label={ar ? "Bindings" : "Bindings"} value={connectedOnly ? data.counts.connectedBindings : data.counts.bindings} tone="violet" />

        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={ar ? "بحث بالاسم / MAC / IP…" : "Search user / MAC / IP…"} className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>

        {mode === "bindings" && (
          <Button
            size="sm"
            variant="outline"
            className={`h-8 text-[11px] border-[#1B2946] ${connectedOnly ? "text-emerald-300" : "text-[#8CA3C3]"}`}
            onClick={() => setConnectedOnly((v) => !v)}
          >
            {connectedOnly ? <Radio className="w-3.5 h-3.5 me-1" /> : <WifiOff className="w-3.5 h-3.5 me-1" />}
            {connectedOnly ? (ar ? "المتصل فقط" : "Connected only") : (ar ? "كل الربط" : "All bindings")}
          </Button>
        )}

        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 me-1 ${loading ? "animate-spin" : ""}`} />{t("syncNow")}
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

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="w-full text-[11.5px]">
            <thead className="bg-[#111C30] sticky top-0 z-10">
              <tr className="text-[#8CA3C3]">
                {mode === "active" && (<>
                  <Th>{t("username")}</Th><Th>IP</Th><Th>MAC</Th><Th>{ar ? "خادم Hotspot" : "Hotspot server"}</Th><Th>{ar ? "الدخول" : "Login by"}</Th>
                  <Th>{t("uptime")}</Th><Th>{t("upload")}</Th><Th>{t("download")}</Th><Th>{t("router")}</Th><Th>{t("actions")}</Th>
                </>)}
                {mode === "hosts" && (<>
                  <Th>MAC</Th><Th>IP</Th><Th>{ar ? "إلى" : "To address"}</Th><Th>{ar ? "خادم Hotspot" : "Hotspot server"}</Th>
                  <Th>{t("uptime")}</Th><Th>{t("upload")}</Th><Th>{t("download")}</Th><Th>{t("status")}</Th><Th>{t("router")}</Th>
                </>)}
                {mode === "bindings" && (<>
                  <Th>MAC</Th><Th>IP</Th><Th>{ar ? "إلى" : "To address"}</Th><Th>{ar ? "النوع" : "Type"}</Th>
                  <Th>{t("status")}</Th><Th>{ar ? "متصل الآن" : "Connected"}</Th><Th>{ar ? "ملاحظة" : "Comment"}</Th><Th>{t("router")}</Th>
                </>)}
              </tr>
            </thead>
            <tbody className="text-[#E2E8F0]">
              {loading && rowsCount === 0 && (
                <tr><td colSpan={10} className="text-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[#1685FF] mx-auto" /></td></tr>
              )}
              {!loading && rowsCount === 0 && (
                <tr><td colSpan={10} className="text-center py-10 text-[#64748B] text-[11px]" dir="auto">
                  {mode === "active"
                    ? (ar ? "لا توجد جلسات Hotspot متصلة الآن" : "No Hotspot sessions connected right now")
                    : mode === "hosts"
                      ? (ar ? "لا توجد أجهزة مستضافة (Hosts) متصلة الآن" : "No Hotspot hosts connected right now")
                      : (ar ? "لا يوجد ربط متصل الآن" : "No connected bindings right now")}
                </td></tr>
              )}

              {mode === "active" && activeRows.map((r) => (
                <tr key={r.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  <Td><span className="font-bold text-[#67E8F9]" dir="auto">{r.user}</span></Td>
                  <Td mono>{r.address ?? "—"}</Td>
                  <Td mono>{r.mac ?? "—"}</Td>
                  <Td mono>{r.server ?? "—"}</Td>
                  <Td mono>{r.loginBy ?? "—"}</Td>
                  <Td mono>{r.uptime ?? "—"}</Td>
                  <Td mono>{r.bytesIn.toFixed(2)} MB</Td>
                  <Td mono>{r.bytesOut.toFixed(2)} MB</Td>
                  <Td>{r.routerName}</Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-red-400 hover:bg-red-950/40"
                      disabled={busyId === r.id}
                      onClick={() => void disconnect(r)}
                    >
                      {busyId === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3 me-1" />}
                      {t("disconnectSession")}
                    </Button>
                  </Td>
                </tr>
              ))}

              {mode === "hosts" && hostRows.map((r) => (
                <tr key={r.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  <Td mono button={!!openDevice} onClick={() => void openByMac(r.mac, openDevice)}>{r.mac}</Td>
                  <Td mono>{r.address ?? "—"}</Td>
                  <Td mono>{r.toAddress ?? "—"}</Td>
                  <Td mono>{r.server ?? "—"}</Td>
                  <Td mono>{r.uptime ?? "—"}</Td>
                  <Td mono>{r.bytesIn.toFixed(2)} MB</Td>
                  <Td mono>{r.bytesOut.toFixed(2)} MB</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <span className="inline-flex items-center gap-1 text-emerald-400 text-[10px] font-bold">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{ar ? "متصل" : "Online"}
                      </span>
                      {r.bypassed && <Badge className="text-[8px] bg-[#8B5CF6] text-white !px-1 !py-0">bypassed</Badge>}
                    </div>
                  </Td>
                  <Td>{r.routerName}</Td>
                </tr>
              ))}

              {mode === "bindings" && bindingRows.map((r) => (
                <tr key={r.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  <Td mono>{r.mac ?? "—"}</Td>
                  <Td mono>{r.address ?? "—"}</Td>
                  <Td mono>{r.toAddress ?? "—"}</Td>
                  <Td>
                    <Badge className={`text-[9px] ${r.type === "bypassed" ? "bg-[#8B5CF6] text-white" : r.type === "blocked" ? "bg-red-600 text-white" : "bg-[#1685FF] text-white"}`} dir="ltr">
                      {r.type}
                    </Badge>
                  </Td>
                  <Td>
                    {r.disabled
                      ? <span className="text-[#64748B] text-[10px]">{ar ? "معطّل" : "Disabled"}</span>
                      : <span className="text-emerald-400 text-[10px] font-bold">{ar ? "مفعّل" : "Enabled"}</span>}
                  </Td>
                  <Td>
                    {r.connected
                      ? <span className="inline-flex items-center gap-1 text-emerald-400 text-[10px] font-bold"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{ar ? "متصل الآن" : "Connected"}</span>
                      : <span className="inline-flex items-center gap-1 text-[#64748B] text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-[#64748B]" />{ar ? "غير متصل" : "Offline"}</span>}
                  </Td>
                  <Td>{r.comment ?? "—"}</Td>
                  <Td>{r.routerName}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-[#111C30] px-3 py-1.5 text-[10px] text-[#64748B]">
          {fmtNum(rowsCount)} {ar ? "صف" : "rows"} · {ar ? "تحديث تلقائي كل 3 ثوانٍ" : "auto-refresh every 3s"}
        </div>
      </div>
    </div>
  );
}

async function openByMac(mac: string, openDevice?: (deviceId: string) => void) {
  if (!openDevice) return;
  try {
    const res = await api<{ devices: { id: string; mac: string }[] }>(`/api/devices?search=${encodeURIComponent(mac)}&pageSize=1&status=online`);
    const id = res.devices[0]?.id;
    if (id) openDevice(id);
  } catch { /* device may not be indexed yet */ }
}

function CounterChip({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: "emerald" | "sky" | "violet" }) {
  const toneCls = tone === "emerald"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : tone === "sky"
      ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
      : "border-violet-500/30 bg-violet-500/10 text-violet-300";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px] font-bold ${toneCls}`}>
      {icon}
      <span className="num">{value}</span>
      <span className="opacity-80">{label}</span>
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-start px-2.5 py-2 font-bold text-[10.5px] whitespace-nowrap">{children}</th>;
}

function Td({ children, mono, button, onClick }: { children?: React.ReactNode; mono?: boolean; button?: boolean; onClick?: () => void }) {
  return (
    <td className="px-2.5 py-1.5 whitespace-nowrap">
      {button ? (
        <button onClick={onClick} className="text-[#22D3EE] hover:underline num" dir="ltr">{children}</button>
      ) : (
        <span className={mono ? "num" : ""} dir={mono ? "ltr" : "auto"}>{children}</span>
      )}
    </td>
  );
}
