"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDateTime, useApp } from "@/lib/store";
import { makeT, type DictKey } from "@/lib/i18n";
import { useDeviceTraffic } from "@/hooks/use-realtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Smartphone, Laptop, Router, Server, Printer, Camera, Tv, Cpu, Wifi,
  Loader2, ShieldBan, ShieldCheck, ShieldAlert, Tag, Activity, Download,
  XCircle, Monitor, HardDrive, RadioTower, ArrowLeftRight,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, Legend, ResponsiveContainer, CartesianGrid, AreaChart, Area,
} from "recharts";

interface DeviceData {
  device: {
    id: string; mac: string; ip: string | null; hostname: string | null; customName: string | null;
    manufacturer: string | null; category: string; os: string | null; connectionType: string;
    interface: string | null; vlan: number | null; ap: string | null; status: string; trustStatus: string;
    sources: string[]; sourceDetails: Record<string, { state?: string; ip?: string; interface?: string; details?: string }>;
    isNew: boolean; firstSeen: string; lastSeen: string | null; lastActive: string | null; comment: string | null;
    router: { id: string; name: string; host: string; status: string; lastSyncAt: string | null; lastSyncOk: boolean | null };
  };
  evidence: {
    dhcp: { status: string; dynamic: boolean; address: string; hostname: string | null; serverName: string | null; expiresAt: string | null; lastSeen: string | null } | null;
    arp: { address: string; interface: string | null; complete: boolean; invalid: boolean; dynamic: boolean } | null;
    bridge: { macAddress: string; bridge: string | null; interface: string | null; vlanId: number | null; dynamic: boolean; isLocal: boolean } | null;
    wireless: { apiPath: string; interface: string | null; ssid: string | null; signal: string | null; txRate: string | null; rxRate: string | null; uptime: string | null; band: string | null } | null;
    ppp: { username: string; service: string | null; address: string | null; profile: string | null; uptime: string | null } | null;
  };
  events: { id: string; type: string; oldValue: string | null; newValue: string | null; details: string | null; source: string | null; ts: string }[];
  ipHistory: { id: string; ipAddress: string; interface: string | null; source: string | null; firstSeen: string; lastSeen: string }[];
  blockRules: { id: string; method: string; status: string; createdAt: string }[];
  usage: { daily: { day: string; downMb: number; upMb: number }[]; recentSamples: { rxMbps: number; txMbps: number; source: string; ts: string }[] };
  sessions: { id: string; username: string; startedAt: string; endedAt: string | null; uploadMb: number; downloadMb: number }[];
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  phone: <Smartphone className="w-4 h-4" />, computer: <Laptop className="w-4 h-4" />,
  router: <Router className="w-4 h-4" />, server: <Server className="w-4 h-4" />,
  printer: <Printer className="w-4 h-4" />, camera: <Camera className="w-4 h-4" />,
  tv: <Tv className="w-4 h-4" />, iot: <Cpu className="w-4 h-4" />,
  nas: <HardDrive className="w-4 h-4" />, access_point: <RadioTower className="w-4 h-4" />,
  switch: <ArrowLeftRight className="w-4 h-4" />,
};

function statusColor(status: string): string {
  switch (status) {
    case "online": return "bg-emerald-500";
    case "offline": return "bg-red-500";
    case "idle": return "bg-sky-400";
    case "blocked": return "bg-orange-500";
    case "recently_disconnected": return "bg-amber-400";
    default: return "bg-slate-500";
  }
}

function statusLabelKey(status: string): DictKey {
  switch (status) {
    case "online": return "statusOnline";
    case "offline": return "statusOffline";
    case "idle": return "statusIdle";
    case "blocked": return "statusBlocked";
    case "recently_disconnected": return "statusRecentlyDisc";
    default: return "statusUnknown";
  }
}

export function DeviceDetailSheet({ deviceId, open, onClose, onChanged }: {
  deviceId: string | null; open: boolean; onClose: () => void; onChanged?: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [data, setData] = useState<DeviceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ explanation: string; commands: string[]; warnings: string[]; method: string } | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [commentVal, setCommentVal] = useState("");
  const [categoryVal, setCategoryVal] = useState("unknown");

  const { samples, mode: trafficMode } = useDeviceTraffic(open ? deviceId : null);

  const load = useCallback(async () => {
    if (!deviceId || !open) return;
    setLoading(true);
    try {
      const d = await api<DeviceData>(`/api/devices/${deviceId}`);
      setData(d);
      setRenameVal(d.device.customName ?? d.device.hostname ?? "");
      setCommentVal(d.device.comment ?? "");
      setCategoryVal(d.device.category);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setLoading(false);
    }
  }, [deviceId, open]);

  useEffect(() => { load(); }, [load]);

  const doAction = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!deviceId) return;
    setBusy(action);
    try {
      const res = await api<{ ok: boolean; detail?: string; replies?: number; detailPing?: string; preview?: { explanation: string; commands: string[]; warnings: string[]; method: string } }>(
        `/api/devices/${deviceId}/actions`,
        { method: "POST", json: { action, ...extra } },
      );
      if (res.preview) { setPreview(res.preview); setConfirmChecked(false); }
      else {
        const msg = res.detail ?? (action === "ping" && res.replies != null ? `ICMP: ${res.replies}/3` : "تم التنفيذ");
        setToast({ msg, ok: true });
        await load();
        onChanged?.();
      }
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setBusy(null);
    }
  };

  const applyConfirmedBlock = async () => {
    if (!preview || !deviceId) return;
    setBusy("block");
    try {
      const res = await api<{ detail?: string }>(`/api/devices/${deviceId}/actions`, { method: "POST", json: { action: "block", method: preview.method, confirm: true } });
      setToast({ msg: res.detail ?? "تم الحجب على السيرفر", ok: true });
      setPreview(null);
      await load();
      onChanged?.();
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setBusy(null); }
  };

  const exportReport = () => {
    if (!data) return;
    const report = {
      generatedAt: new Date().toISOString(),
      device: data.device,
      evidence: data.evidence,
      events: data.events,
      ipHistory: data.ipHistory,
      usageDaily: data.usage.daily,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `device-report-${data.device.mac.replace(/:/g, "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const d = data?.device;
  const liveChart = samples.map((s) => ({
    time: new Date(s.ts).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    down: Number(s.rxMbps.toFixed(3)),
    up: Number(s.txMbps.toFixed(3)),
  }));
  const dailyChart = data?.usage.daily.map((x) => ({ day: x.day, down: Number((x.downMb / 1024).toFixed(2)), up: Number((x.upMb / 1024).toFixed(2)) })) ?? [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side={lang === "ar" ? "left" : "right"} className="w-full sm:max-w-[640px] bg-[#0A1020] border-[#1B2946] overflow-y-auto p-0">
        <SheetHeader className="p-4 pb-0">
          <SheetTitle className="flex items-center gap-2 text-white text-base">
            {d ? (CATEGORY_ICONS[d.category] ?? <Monitor className="w-4 h-4" />) : <Monitor className="w-4 h-4" />}
            <span className="truncate" dir="auto">{d ? (d.customName || d.hostname || d.mac) : t("deviceProfile")}</span>
            {d && <span className={`dot ${statusColor(d.status)} !w-2.5 !h-2.5 shrink-0`} title={d.status} />}
            <Button variant="ghost" size="icon" className="ms-auto shrink-0" onClick={onClose} aria-label="close"><XCircle className="w-4 h-4" /></Button>
          </SheetTitle>
        </SheetHeader>
        {loading && !d && (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-[#1685FF]" /></div>
        )}
        {d && (
          <div className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className="bg-emerald-600 text-white text-[10px]" style={{ background: statusVar(d.status) }}>{t(statusLabelKey(d.status))}</Badge>
              {d.trustStatus !== "unknown" && (
                <Badge variant="outline" className="text-[10px] border-[#1B2946] text-[#8CA3C3]">
                  {d.trustStatus === "trusted" ? t("trusted") : d.trustStatus === "suspicious" ? t("suspicious") : t("statusBlocked")}
                </Badge>
              )}
              {d.sources.map((s) => <Badge key={s} variant="outline" className="text-[9px] border-[#1B2946] text-[#22D3EE]" dir="ltr">{s}</Badge>)}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {d.status !== "blocked" ? (
                <Button size="sm" variant="destructive" className="h-8 text-[11px]" onClick={() => doAction("block_preview", { method: "firewall_forward_drop" })} disabled={busy !== null}>
                  <ShieldBan className="w-3.5 h-3.5 me-1" />{t("blockDevice")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => doAction("unblock")} disabled={busy !== null}>
                  <ShieldCheck className="w-3.5 h-3.5 me-1" />{t("unblockDevice")}
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => doAction("reserve_ip")} disabled={busy !== null}><Tag className="w-3.5 h-3.5 me-1" />{t("reserveIp")}</Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => doAction("trust")} disabled={busy !== null}><ShieldCheck className="w-3.5 h-3.5 me-1" />{t("trustDevice")}</Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => doAction("mark_suspicious")} disabled={busy !== null}><ShieldAlert className="w-3.5 h-3.5 me-1" />{t("markSuspicious")}</Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => doAction("ping")} disabled={busy !== null}><Activity className="w-3.5 h-3.5 me-1" />{t("pingCheck")}</Button>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={exportReport}><Download className="w-3.5 h-3.5 me-1" />{t("exportDeviceReport")}</Button>
            </div>

            {toast && (
              <Alert className={`!py-2 ${toast.ok ? "border-emerald-700/50 bg-emerald-950/30" : "border-red-800/50 bg-red-950/30"}`}>
                <AlertDescription className={`text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">{toast.msg}</AlertDescription>
              </Alert>
            )}

            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="bg-[#111C30] h-8">
                <TabsTrigger value="overview" className="text-[11px] h-7">{t("overview")}</TabsTrigger>
                <TabsTrigger value="evidence" className="text-[11px] h-7">{t("evidence")}</TabsTrigger>
                <TabsTrigger value="history" className="text-[11px] h-7">{t("history")}</TabsTrigger>
                <TabsTrigger value="usage" className="text-[11px] h-7">{t("usageTab")}</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-3">
                <div className="panel p-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                  <Info label="MAC" value={d.mac} mono />
                  <Info label="IP" value={d.ip ?? "—"} mono />
                  <Info label={t("hostname")} value={d.hostname ?? "—"} />
                  <Info label={t("manufacturer")} value={d.manufacturer ?? t("unknownStatus")} />
                  <Info label={t("connection")} value={d.connectionType} />
                  <Info label={t("interface")} value={d.interface ?? "—"} mono />
                  {d.vlan != null && <Info label={t("vlan")} value={String(d.vlan)} mono />}
                  {d.ap && <Info label={t("ap")} value={d.ap} mono />}
                  {d.os && <Info label={t("osLabel")} value={d.os} />}
                  <Info label={t("firstSeenCol")} value={fmtDateTime(d.firstSeen)} />
                  <Info label={t("lastSeenCol")} value={d.lastSeen ? fmtDateTime(d.lastSeen) : "—"} />
                  <Info label={t("router")} value={`${d.router.name} (${d.router.host})`} mono />
                  <Info label={t("lastSync")} value={d.router.lastSyncAt ? fmtDateTime(d.router.lastSyncAt) : t("neverSynced")} />
                </div>
                <div className="panel p-3 space-y-2">
                  <div className="text-[12px] font-bold text-[#CBD5E1]">{t("renameDevice")}</div>
                  <div className="flex gap-2">
                    <Input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]" />
                    <Button size="sm" className="h-8 text-[11px]" onClick={() => doAction("rename", { name: renameVal })}>{t("save")}</Button>
                  </div>
                </div>
                <div className="panel p-3 space-y-2">
                  <div className="text-[12px] font-bold text-[#CBD5E1]">{t("categorizeDevice")}</div>
                  <div className="flex gap-2 items-center">
                    <Select value={categoryVal} onValueChange={setCategoryVal}>
                      <SelectTrigger className="h-8 text-[12px] bg-[#111C30] border-[#1B2946] w-40"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-[#111C30] border-[#1B2946]">
                        {["phone", "computer", "router", "access_point", "switch", "server", "printer", "camera", "tv", "iot", "nas", "unknown"].map((c) => (
                          <SelectItem key={c} value={c} className="text-[12px]">{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 text-[11px]" onClick={() => doAction("categorize", { category: categoryVal })}>{t("save")}</Button>
                  </div>
                </div>
                <div className="panel p-3 space-y-2">
                  <div className="text-[12px] font-bold text-[#CBD5E1]">{t("addComment")}</div>
                  <Input value={commentVal} onChange={(e) => setCommentVal(e.target.value)} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]" />
                  <Button size="sm" className="h-8 text-[11px]" onClick={() => doAction("comment", { comment: commentVal })}>{t("save")}</Button>
                </div>
              </TabsContent>

              <TabsContent value="evidence" className="space-y-3">
                <div className="panel p-3 text-[12px] space-y-2">
                  {Object.entries(d.sourceDetails).map(([src, ev]) => (
                    <div key={src} className="flex flex-wrap items-baseline gap-2 border-b border-[#1B2946]/60 pb-1.5" dir="ltr">
                      <span className="font-bold text-[#22D3EE] w-24">{src}</span>
                      <span className="text-[#8CA3C3]">{ev.state ?? ""}</span>
                      {ev.ip && <span className="text-[#F1F5F9]">{ev.ip}</span>}
                      {ev.interface && <span className="text-[#8CA3C3]">{ev.interface}</span>}
                      {ev.details && <span className="text-[#64748B] text-[10px]">{ev.details}</span>}
                    </div>
                  ))}
                </div>
                {data?.evidence.dhcp && (
                  <div className="panel p-3 text-[12px] space-y-1.5">
                    <div className="font-bold text-[#CBD5E1] mb-1">DHCP</div>
                    <Info label={t("leaseStatus")} value={data.evidence.dhcp.status} mono />
                    <Info label={t("dynamicLease") + " / " + t("staticLease")} value={data.evidence.dhcp.dynamic ? t("dynamicLease") : t("staticLease")} />
                    <Info label={t("server")} value={data.evidence.dhcp.serverName ?? "—"} />
                    {data.evidence.dhcp.expiresAt && <Info label={t("expiresAfter")} value={fmtDateTime(data.evidence.dhcp.expiresAt)} />}
                  </div>
                )}
                {data?.evidence.arp && (
                  <div className="panel p-3 text-[12px] space-y-1.5">
                    <div className="font-bold text-[#CBD5E1] mb-1">ARP</div>
                    <Info label={t("status")} value={data.evidence.arp.complete ? t("reachable") : data.evidence.arp.invalid ? t("failedState") : t("incomplete")} />
                    <Info label={t("interface")} value={data.evidence.arp.interface ?? "—"} mono />
                    <Info label={t("dynamicLease")} value={data.evidence.arp.dynamic ? t("dynamicLease") : t("staticLease")} />
                  </div>
                )}
                {data?.evidence.bridge && (
                  <div className="panel p-3 text-[12px] space-y-1.5">
                    <div className="font-bold text-[#CBD5E1] mb-1">L2 / Bridge</div>
                    <Info label={t("bridge")} value={data.evidence.bridge.bridge ?? "—"} mono />
                    <Info label={t("port")} value={data.evidence.bridge.interface ?? "—"} mono />
                    {data.evidence.bridge.vlanId != null && <Info label={t("vlan")} value={String(data.evidence.bridge.vlanId)} mono />}
                    <Info label={t("dynamicLease")} value={data.evidence.bridge.dynamic ? t("dynamicLease") : t("staticLease")} />
                  </div>
                )}
                {data?.evidence.wireless && (
                  <div className="panel p-3 text-[12px] space-y-1.5">
                    <div className="font-bold text-[#CBD5E1] mb-1 flex items-center gap-1"><Wifi className="w-3.5 h-3.5" />Wireless ({data.evidence.wireless.apiPath})</div>
                    {data.evidence.wireless.ssid && <Info label={t("ssid")} value={data.evidence.wireless.ssid} />}
                    <Info label={t("ap")} value={data.evidence.wireless.interface ?? "—"} mono />
                    {data.evidence.wireless.signal && <Info label={t("signal")} value={data.evidence.wireless.signal} mono />}
                    {data.evidence.wireless.txRate && <Info label={t("txRate")} value={data.evidence.wireless.txRate} mono />}
                    {data.evidence.wireless.rxRate && <Info label={t("rxRate")} value={data.evidence.wireless.rxRate} mono />}
                    {data.evidence.wireless.band && <Info label={t("band")} value={data.evidence.wireless.band} mono />}
                    {data.evidence.wireless.uptime && <Info label={t("uptime")} value={data.evidence.wireless.uptime} mono />}
                  </div>
                )}
                {data?.evidence.ppp && (
                  <div className="panel p-3 text-[12px] space-y-1.5">
                    <div className="font-bold text-[#CBD5E1] mb-1">PPPoE</div>
                    <Info label={t("username")} value={data.evidence.ppp.username} mono />
                    <Info label="IP" value={data.evidence.ppp.address ?? "—"} mono />
                    <Info label={t("package")} value={data.evidence.ppp.profile ?? "—"} />
                    {data.evidence.ppp.uptime && <Info label={t("uptime")} value={data.evidence.ppp.uptime} mono />}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="history" className="space-y-3">
                <div className="panel p-3">
                  <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">{t("history")}</div>
                  <ScrollArea className="max-h-72">
                    <div className="space-y-1.5">
                      {data?.events.length === 0 && <div className="text-[11px] text-[#64748B]">{t("noData")}</div>}
                      {data?.events.map((ev) => (
                        <div key={ev.id} className="flex items-baseline gap-2 text-[11px] border-b border-[#1B2946]/50 pb-1">
                          <span className="text-[#64748B] w-28 shrink-0">{fmtDateTime(ev.ts)}</span>
                          <Badge variant="outline" className="text-[9px] border-[#1B2946] text-[#22D3EE] shrink-0">{ev.type}</Badge>
                          {ev.oldValue && <span className="text-[#8CA3C3]" dir="ltr">{ev.oldValue} →</span>}
                          {ev.newValue && <span className="text-[#F1F5F9]" dir="ltr">{ev.newValue}</span>}
                          {ev.details && <span className="text-[#64748B] truncate" dir="auto">{ev.details}</span>}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
                <div className="panel p-3">
                  <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">IP {t("history")}</div>
                  <div className="space-y-1">
                    {data?.ipHistory.map((h) => (
                      <div key={h.id} className="flex items-baseline gap-2 text-[11px]" dir="ltr">
                        <span className="text-[#F1F5F9]">{h.ipAddress}</span>
                        <span className="text-[#64748B]">{h.interface ?? ""}</span>
                        <span className="text-[#64748B]">{fmtDateTime(h.firstSeen)} → {fmtDateTime(h.lastSeen)}</span>
                      </div>
                    ))}
                    {data?.ipHistory.length === 0 && <div className="text-[11px] text-[#64748B]">{t("noData")}</div>}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="usage" className="space-y-3">
                <div className="panel p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[12px] font-bold text-[#CBD5E1]">{t("liveTraffic")}</div>
                    <span className="text-[10px] text-[#64748B]">{trafficMode === "socket" ? t("realtimeConnected") : trafficMode === "polling" ? t("realtimePolling") : "…"}</span>
                  </div>
                  {liveChart.length > 1 ? (
                    <ResponsiveContainer width="100%" height={180}>
                      <AreaChart data={liveChart}>
                        <defs>
                          <linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22D3EE" stopOpacity={0.4} /><stop offset="100%" stopColor="#22D3EE" stopOpacity={0} /></linearGradient>
                          <linearGradient id="ug" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1685FF" stopOpacity={0.4} /><stop offset="100%" stopColor="#1685FF" stopOpacity={0} /></linearGradient>
                        </defs>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="time" tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} unit=" Mbps" width={70} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Area type="monotone" dataKey="down" stroke="#22D3EE" fill="url(#dg)" name={t("downloadMbps")} strokeWidth={2} dot={false} />
                        <Area type="monotone" dataKey="up" stroke="#1685FF" fill="url(#ug)" name={t("uploadMbps")} strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-[11px] text-[#64748B] py-6 text-center">{t("noRouterSync")}</div>
                  )}
                </div>
                <div className="panel p-3">
                  <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">{t("dailyUsage")}</div>
                  {dailyChart.length > 0 ? (
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={dailyChart}>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="day" tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} unit=" GB" width={70} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Line type="monotone" dataKey="down" stroke="#22D3EE" name={t("download")} dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="up" stroke="#1685FF" name={t("upload")} dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-[11px] text-[#64748B] py-6 text-center">{t("noData")}</div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}

        <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
          <DialogContent className="bg-[#0E1A31] border-[#1B2946] text-[#F1F5F9] max-w-lg">
            <DialogHeader><DialogTitle className="text-[14px] flex items-center gap-2"><ShieldBan className="w-4 h-4 text-red-400" />{t("blockPreviewTitle")}</DialogTitle></DialogHeader>
            {preview && (
              <div className="space-y-3 text-[12px]">
                <div>
                  <div className="font-bold text-[#CBD5E1] mb-1">{t("blockPreviewExpl")}</div>
                  <p className="text-[#8CA3C3]" dir="auto">{preview.explanation}</p>
                </div>
                <div>
                  <div className="font-bold text-[#CBD5E1] mb-1">{t("blockPreviewCmds")}</div>
                  <pre className="bg-[#0A1020] border border-[#1B2946] rounded-lg p-2 text-[10px] text-[#22D3EE] overflow-x-auto" dir="ltr">{preview.commands.join("\n")}</pre>
                </div>
                <div>
                  <div className="font-bold text-[#CBD5E1] mb-1">{t("blockPreviewWarn")}</div>
                  <ul className="list-disc ps-4 text-[#F59E0B] space-y-1" dir="auto">
                    {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={confirmChecked} onCheckedChange={(v) => setConfirmChecked(v === true)} />
                  <span className="text-[12px] text-[#CBD5E1]" dir="auto">{t("confirmApply")}</span>
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" className="h-8 text-[11px] border-[#1B2946]" onClick={() => setPreview(null)}>{t("cancel")}</Button>
                  <Button size="sm" className="h-8 text-[11px] bg-red-600 hover:bg-red-500" disabled={!confirmChecked || busy !== null} onClick={applyConfirmedBlock}>
                    {busy === "block" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldBan className="w-3.5 h-3.5 me-1" />}
                    {t("confirm")}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

function statusVar(status: string): string {
  switch (status) {
    case "online": return "#10B981";
    case "offline": return "#EF4444";
    case "idle": return "#38BDF8";
    case "blocked": return "#F97316";
    case "recently_disconnected": return "#FBBF24";
    default: return "#64748B";
  }
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[#1B2946]/40 pb-1">
      <span className="text-[#64748B] text-[11px] shrink-0">{label}</span>
      <span className={`text-[#F1F5F9] text-[11.5px] truncate ${mono ? "num" : ""}`} dir={mono ? "ltr" : "auto"}>{value}</span>
    </div>
  );
}
