"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, authFetch, fmtDateTime, fmtNum, useApp } from "@/lib/store";
import { makeT, type DictKey } from "@/lib/i18n";
import { useRealtime, type RealtimeDevice, type RealtimeStats } from "@/hooks/use-realtime";
import { DeviceDetailSheet } from "@/components/devices/device-detail-sheet";
import { SourceTable } from "@/components/devices/source-tables";
import { HotspotLivePanel } from "@/components/devices/hotspot-live-panel";
import { LiveTrafficPanel } from "@/components/devices/live-traffic";
import { NetworkResourcesPanel } from "@/components/devices/network-resources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Loader2, RefreshCw, Search, Download, Radio, Wifi, Laptop, Users, MonitorSmartphone, Link2,
  Server, ShieldBan, Sparkles, Boxes, CircleDot, ChevronRight, Zap, AlertTriangle,
} from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip,
  Legend, ResponsiveContainer, CartesianGrid, AreaChart, Area,
} from "recharts";

interface RouterMeta { id: string; name: string; host: string; status: string; lastSyncAt: string | null; lastSyncOk: boolean | null; lastSyncError: string | null; syncEnabled: boolean; syncIntervalSec: number; isDemo: boolean }

interface DeviceRow {
  id: string; mac: string; ip: string | null; hostname: string | null; customName: string | null;
  manufacturer: string | null; category: string; os: string | null; connectionType: string;
  interface: string | null; vlan: number | null; ap: string | null; status: string; trustStatus: string;
  sources: string[]; isNew: boolean; firstSeen: string; lastSeen: string | null; lastActive: string | null;
  comment: string | null;
  router: { id: string; name: string; status: string; lastSyncAt: string | null; lastSyncOk: boolean | null; isDemo: boolean };
}

interface StatsPayload {
  kpi: RealtimeStats;
  onlineOverTime: { ts: string; online: number; offline: number; total: number }[];
  byRouter: { id: string; count: number }[];
  byVlan: { vlan: string; count: number }[];
  byAp: { ap: string; count: number }[];
  byType: { type: string; count: number }[];
  byManufacturer: { manufacturer: string; count: number }[];
  newPerDay: { day: string; count: number }[];
  routers: RouterMeta[];
}

const TABS = ["dashboard", "inventory", "unknown", "dhcp_leases", "arp", "bridge_hosts", "wireless", "hotspot_active", "hotspot_hosts", "hotspot_bindings", "ppp_active", "traffic", "resources"] as const;
type TabKey = (typeof TABS)[number];

const COLORS = ["#1685FF", "#22D3EE", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"];

export function DevicesView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  const [routerId, setRouterId] = useState("all");
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [liveCounts, setLiveCounts] = useState<{ active: number; hosts: number; bindings: number; connectedBindings: number } | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [search, setSearch] = useState("");
  // The operator only wants connected devices in the inventory: default to
  // "online" and let the status selector bring the rest back when needed.
  const [statusFilter, setStatusFilter] = useState("online");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [searchDebounced, setSearchDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => { setSearchDebounced(search); setPage(1); }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        api<StatsPayload>(`/api/devices?stats=1&routerId=${routerId}&_=${Date.now()}`),
        api<{ total: number; devices: DeviceRow[] }>(`/api/devices?routerId=${routerId}&page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(searchDebounced)}&status=${statusFilter === "all" ? "" : statusFilter}&connectionType=${typeFilter === "all" ? "" : typeFilter}&sort=lastSeen&dir=desc&_=${Date.now()}`),
      ]);
      setStats(s);
      setDevices(d.devices);
      setTotal(d.total);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setLoading(false);
    }
  }, [routerId, page, pageSize, searchDebounced, statusFilter, typeFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  // Live Hotspot counters for the dashboard KPIs — read from the router every
  // 3 seconds so Active / Hosts / Bindings are never a stale DB snapshot.
  useEffect(() => {
    if (tab !== "dashboard") return;
    let disposed = false;
    const pull = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await api<{ counts: { active: number; hosts: number; bindings: number; connectedBindings: number } }>(`/api/hotspot/live?routerId=${routerId}&_=${Date.now()}`);
        if (!disposed) setLiveCounts(res.counts);
      } catch { /* keep the previous value while the router reconnects */ }
    };
    pull();
    const timer = setInterval(pull, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [routerId, tab]);

  // realtime updates (socket primary, polling fallback)
  const { mode } = useRealtime({
    pollDevicesMs: 8000,
    onStats: (k) => setStats((prev) => (prev ? { ...prev, kpi: k } : prev)),
    onDevices: (incoming: RealtimeDevice[]) => {
      setDevices((prev) => {
        const map = new Map(prev.map((d) => [d.id, d]));
        for (const u of incoming) {
          const existing = map.get(u.id);
          map.set(u.id, existing
            ? { ...existing, ...u, interface: u.interface ?? null, vlan: u.vlan ?? null, ap: u.ap ?? null, hostname: u.hostname, customName: u.customName, router: existing.router }
            : { ...(u as unknown as DeviceRow), router: { id: "", name: u.router?.name ?? "", status: "online", lastSyncAt: null, lastSyncOk: null, isDemo: false } });
        }
        // Never let the realtime stream (which carries every device) re-add a
        // disconnected device to a list the operator filtered to online only.
        const merged = [...map.values()];
        return statusFilter === "all" ? merged : merged.filter((d) => d.status === statusFilter);
      });
      // light refresh for stats accuracy
      authFetch(`/api/devices?stats=1&routerId=${routerId}`).then((r) => r.json()).then((s: StatsPayload) => setStats(s)).catch(() => {});
    },
  });

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await api<{ results: { ok: boolean; error?: string }[] }>("/api/discovery", { method: "POST", json: { routerId: routerId } });
      const failed = res.results.filter((r) => !r.ok);
      setToast(
        failed.length === 0
          ? { msg: lang === "ar" ? "بدأت مزامنة الاكتشاف — النتائج ستظهر خلال لحظات" : "Discovery sync started — results will appear shortly", ok: true }
          : { msg: failed.map((f) => f.error).join(" | "), ok: false },
      );
      setTimeout(refresh, 2500);
      setTimeout(refresh, 8000);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setSyncing(false);
    }
  };

  const bulkAction = async (action: string) => {
    if (selectedIds.size === 0) return;
    try {
      for (const id of selectedIds) {
        await api(`/api/devices/${id}/actions`, { method: "POST", json: { action, confirm: true } });
      }
      setToast({ msg: `${selectedIds.size} ${lang === "ar" ? "جهاز تم تحديثه" : "devices updated"}`, ok: true });
      setSelectedIds(new Set());
      refresh();
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    }
  };

  const routers = stats?.routers ?? [];
  const kpi = stats?.kpi;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const unknownDevices = useMemo(() => devices.filter((d) => d.isNew || d.trustStatus === "unknown" && d.firstSeen && Date.now() - new Date(d.firstSeen).getTime() < 7 * 86400_000), [devices]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) => (prev.size > 0 ? new Set() : new Set(devices.map((d) => d.id))));
  };

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-extrabold text-white flex items-center gap-2">
          <Boxes className="w-4.5 h-4.5 text-[#22D3EE]" />
          {t("devices")}
        </h2>
        <Select value={routerId} onValueChange={setRouterId}>
          <SelectTrigger className="h-8 w-44 text-[11.5px] bg-[#111C30] border-[#1B2946]"><SelectValue /></SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946]">
            <SelectItem value="all" className="text-[11.5px]">{t("allServers")}</SelectItem>
            {routers.map((r) => (
              <SelectItem key={r.id} value={r.id} className="text-[11.5px]" dir="ltr">{r.name} {r.isDemo ? "(DEMO)" : ""}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="h-8 text-[11px]" onClick={() => { setRouterId("all"); setToast({ msg: lang === "ar" ? "تم إعادة التعيين إلى جميع السيرفرات" : "Reset to all routers", ok: true }); }}>
          <RefreshCw className="w-3.5 h-3.5 me-1" />
          {t("resetAll")}
        </Button>
        <Button size="sm" className="h-8 text-[11px]" onClick={syncNow} disabled={syncing}>
          {syncing ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 me-1" />}
          {t("syncNow")}
        </Button>
        <Badge variant="outline" className="text-[10px] border-[#1B2946] text-[#8CA3C3]">
          <Radio className="w-3 h-3 me-1 text-[#22D3EE]" />
          {mode === "socket" ? t("realtimeConnected") : mode === "polling" ? t("realtimePolling") : "…"}
        </Badge>
        <div className="ms-auto text-[10.5px] text-[#64748B]" dir="auto">
          {routers.some((r) => !r.lastSyncAt) || routers.every((r) => r.status !== "online")
            ? t("noRouterSync")
            : routers.map((r) => `${r.name}: ${r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : t("neverSynced")}`).join(" · ")}
        </div>
      </div>

      {toast && (
        <Alert className={`!py-2 ${toast.ok ? "border-emerald-700/50 bg-emerald-950/30" : "border-red-800/50 bg-red-950/30"}`}>
          <AlertDescription className={`text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">{toast.msg}</AlertDescription>
        </Alert>
      )}

      {/* tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="bg-[#111C30] h-9 flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="dashboard" className="text-[11px] h-7">{t("devDashboard")}</TabsTrigger>
          <TabsTrigger value="inventory" className="text-[11px] h-7">{t("devInventory")}</TabsTrigger>
          <TabsTrigger value="unknown" className="text-[11px] h-7">{t("unknownDevices")}</TabsTrigger>
          <TabsTrigger value="dhcp_leases" className="text-[11px] h-7">{t("dhcpLeases")}</TabsTrigger>
          <TabsTrigger value="arp" className="text-[11px] h-7">{t("arpTable")}</TabsTrigger>
          <TabsTrigger value="bridge_hosts" className="text-[11px] h-7">{t("bridgeHosts")}</TabsTrigger>
          <TabsTrigger value="wireless" className="text-[11px] h-7">{t("wirelessClients")}</TabsTrigger>
          <TabsTrigger value="hotspot_active" className="text-[11px] h-7">{t("hotspotSessions")}</TabsTrigger>
          <TabsTrigger value="hotspot_hosts" className="text-[11px] h-7">{t("hotspotHosts")}</TabsTrigger>
          <TabsTrigger value="hotspot_bindings" className="text-[11px] h-7">{t("hotspotBindings")}</TabsTrigger>
          <TabsTrigger value="ppp_active" className="text-[11px] h-7">{t("pppoeSessions")}</TabsTrigger>
          <TabsTrigger value="traffic" className="text-[11px] h-7">{t("liveTraffic")}</TabsTrigger>
          <TabsTrigger value="resources" className="text-[11px] h-7">{t("networkResources")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* DASHBOARD */}
      {tab === "dashboard" && (
        <div className="space-y-4">
          {!kpi && loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-[76px] bg-[#111C30]" />)}
            </div>
          ) : kpi && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <KpiCard icon={<Boxes className="w-4 h-4 text-[#1685FF]" />} label={t("totalDevices")} value={fmtNum(kpi.total)} />
                <KpiCard icon={<CircleDot className="w-4 h-4 text-emerald-400" />} label={t("onlineNow")} value={fmtNum(kpi.online)} accent="emerald" />
                <KpiCard icon={<Users className="w-4 h-4 text-emerald-400" />} label={t("hotspotActiveNow")} value={fmtNum(liveCounts?.active ?? 0)} accent="emerald" live />
                <KpiCard icon={<MonitorSmartphone className="w-4 h-4 text-sky-400" />} label={t("hotspotHostsNow")} value={fmtNum(liveCounts?.hosts ?? 0)} accent="amber" live />
                <KpiCard icon={<Link2 className="w-4 h-4 text-violet-400" />} label={t("hotspotBindingsNow")} value={fmtNum(liveCounts?.connectedBindings ?? 0)} live />
                <KpiCard icon={<Wifi className="w-4 h-4 text-[#22D3EE]" />} label={t("wirelessClients")} value={fmtNum(kpi.wireless)} />
                <KpiCard icon={<Laptop className="w-4 h-4 text-[#1685FF]" />} label={t("wiredDevices")} value={fmtNum(kpi.wired)} />
                <KpiCard icon={<Server className="w-4 h-4 text-[#1685FF]" />} label={t("pppoeClients")} value={fmtNum(kpi.pppoe)} />
                <KpiCard icon={<Sparkles className="w-4 h-4 text-amber-400" />} label={t("newDevices")} value={fmtNum(kpi.newDevices)} accent="amber" />
                <KpiCard icon={<ShieldBan className="w-4 h-4 text-orange-400" />} label={t("blockedDevices")} value={fmtNum(kpi.blockedDevices)} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ChartPanel title={t("onlineOverTime")}>
                  {stats && stats.onlineOverTime.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={stats.onlineOverTime}>
                        <defs><linearGradient id="on" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10B981" stopOpacity={0.35} /><stop offset="100%" stopColor="#10B981" stopOpacity={0} /></linearGradient></defs>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="ts" tickFormatter={(v) => new Date(v).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit" })} tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Area type="monotone" dataKey="online" stroke="#10B981" fill="url(#on)" strokeWidth={2} name={t("onlineNow")} dot={false} />
                        <Area type="monotone" dataKey="total" stroke="#1685FF" fill="none" strokeWidth={1.4} name={t("totalDevices")} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={t("noRouterSync")} />}
                </ChartPanel>

                <ChartPanel title={t("wiredVsWireless")}>
                  {stats && kpi && kpi.total > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={[{ name: t("wiredDevices"), value: kpi.wired }, { name: t("wirelessClients"), value: kpi.wireless }, { name: t("hotspotClients"), value: kpi.hotspot }, { name: t("pppoeClients"), value: kpi.pppoe }, { name: t("unknownStatus"), value: Math.max(0, kpi.total - kpi.wired - kpi.wireless - kpi.hotspot - kpi.pppoe) }]} dataKey="value" innerRadius={45} outerRadius={75} paddingAngle={3}>
                          {COLORS.map((c, i) => <Cell key={i} fill={c} />)}
                        </Pie>
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={t("noRouterSync")} />}
                </ChartPanel>

                <ChartPanel title={t("discoveryHistory")}>
                  {stats && stats.newPerDay.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.newPerDay}>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="day" tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} allowDecimals={false} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Bar dataKey="count" fill="#22D3EE" name={t("newDevices")} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={t("noRouterSync")} />}
                </ChartPanel>

                <ChartPanel title={t("devicesByVlan")}>
                  {stats && stats.byVlan.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.byVlan}>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="vlan" tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} allowDecimals={false} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Bar dataKey="count" fill="#8B5CF6" name={t("totalDevices")} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={lang === "ar" ? "لا توجد VLANs مكتشفة بعد" : "No VLANs discovered yet"} />}
                </ChartPanel>

                <ChartPanel title={t("devicesByAp")}>
                  {stats && stats.byAp.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.byAp} layout="vertical">
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis type="number" tick={{ fill: "#64748B", fontSize: 9 }} allowDecimals={false} />
                        <YAxis type="category" dataKey="ap" width={90} tick={{ fill: "#8CA3C3", fontSize: 9 }} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Bar dataKey="count" fill="#1685FF" name={t("totalDevices")} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={t("noRouterSync")} />}
                </ChartPanel>

                <ChartPanel title={t("connTypeDist")}>
                  {stats && stats.byType.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.byType}>
                        <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                        <XAxis dataKey="type" tick={{ fill: "#64748B", fontSize: 9 }} />
                        <YAxis tick={{ fill: "#64748B", fontSize: 9 }} allowDecimals={false} />
                        <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                        <Bar dataKey="count" name={t("totalDevices")} radius={[4, 4, 0, 0]}>
                          {stats.byType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart text={t("noRouterSync")} />}
                </ChartPanel>
              </div>
            </>
          )}
        </div>
      )}

      {/* INVENTORY */}
      {tab === "inventory" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("macSearch")} className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-36 text-[11px] bg-[#111C30] border-[#1B2946]"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-[#111C30] border-[#1B2946]">
                <SelectItem value="all" className="text-[11px]">{t("status")}: {t("total")}</SelectItem>
                <SelectItem value="online" className="text-[11px]">{t("statusOnline")}</SelectItem>
                <SelectItem value="offline" className="text-[11px]">{t("statusOffline")}</SelectItem>
                <SelectItem value="idle" className="text-[11px]">{t("statusIdle")}</SelectItem>
                <SelectItem value="unknown" className="text-[11px]">{t("statusUnknown")}</SelectItem>
                <SelectItem value="blocked" className="text-[11px]">{t("statusBlocked")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
              <SelectTrigger className="h-8 w-32 text-[11px] bg-[#111C30] border-[#1B2946]"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-[#111C30] border-[#1B2946]">
                <SelectItem value="all" className="text-[11px]">{t("connection")}: {t("total")}</SelectItem>
                <SelectItem value="wired" className="text-[11px]">wired</SelectItem>
                <SelectItem value="wireless" className="text-[11px]">wireless</SelectItem>
                <SelectItem value="hotspot" className="text-[11px]">hotspot</SelectItem>
                <SelectItem value="pppoe" className="text-[11px]">pppoe</SelectItem>
              </SelectContent>
            </Select>
            <a href={`/api/devices?format=csv&routerId=${routerId}`} download>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]"><Download className="w-3.5 h-3.5 me-1" />CSV</Button>
            </a>
            <a href={`/api/devices?format=xls&routerId=${routerId}`} download>
              <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]"><Download className="w-3.5 h-3.5 me-1" />Excel</Button>
            </a>
            {selectedIds.size > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="h-8 text-[11px]"><Zap className="w-3.5 h-3.5 me-1" />{selectedIds.size} {t("selected")}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="bg-[#111C30] border-[#1B2946] text-[11px]">
                  <DropdownMenuItem onClick={() => bulkAction("trust")}>{t("bulkTrust")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulkAction("clear_new")}>{t("bulkClearNew")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulkAction("mark_suspicious")} className="text-amber-400">{t("markSuspicious")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead className="bg-[#111C30]">
                  <tr className="text-[#8CA3C3]">
                    <th className="px-2 py-2 w-8"><input type="checkbox" checked={selectedIds.size > 0 && selectedIds.size === devices.length} onChange={selectAllVisible} className="accent-[#1685FF]" aria-label="select all" /></th>
                    <th className="text-start px-2 py-2">{t("status")}</th>
                    <th className="text-start px-2 py-2">{t("device")}</th>
                    <th className="text-start px-2 py-2">IP</th>
                    <th className="text-start px-2 py-2">MAC</th>
                    <th className="text-start px-2 py-2">{t("type")}</th>
                    <th className="text-start px-2 py-2">{t("connection")}</th>
                    <th className="text-start px-2 py-2">{t("interface")}</th>
                    <th className="text-start px-2 py-2">{t("router")}</th>
                    <th className="text-start px-2 py-2">{t("lastSeenCol")}</th>
                    <th className="text-start px-2 py-2">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody className="text-[#E2E8F0]">
                  {loading && devices.length === 0 && (
                    <tr><td colSpan={11} className="text-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[#1685FF] mx-auto" /></td></tr>
                  )}
                  {!loading && devices.length === 0 && (
                    <tr><td colSpan={11} className="text-center py-10 text-[#64748B] text-[11px]" dir="auto">{t("noRouterSync")}</td></tr>
                  )}
                  {devices.map((d) => (
                    <tr key={d.id} className={`border-t border-[#1B2946]/60 hover:bg-[#111C30]/60 ${selectedIds.has(d.id) ? "bg-[#111C30]" : ""}`}>
                      <td className="px-2 py-1.5"><input type="checkbox" checked={selectedIds.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-[#1685FF]" aria-label={`select ${d.mac}`} /></td>
                      <td className="px-2 py-1.5">
                        <StatusDot status={d.status} label={t(statusKey(d.status))} />
                      </td>
                      <td className="px-2 py-1.5 max-w-[160px]">
                        <button className="hover:underline text-start truncate block max-w-full" dir="auto" onClick={() => setDetailId(d.id)}>
                          {d.customName || d.hostname || <span dir="ltr" className="num">{d.mac}</span>}
                        </button>
                        {d.manufacturer && <div className="text-[9px] text-[#64748B] truncate" dir="ltr">{d.manufacturer}</div>}
                        {d.isNew && <Badge className="text-[8px] bg-amber-500 text-black !px-1 !py-0">NEW</Badge>}
                      </td>
                      <td className="px-2 py-1.5 num" dir="ltr">{d.ip ?? "—"}</td>
                      <td className="px-2 py-1.5"><button className="text-[#22D3EE] hover:underline num" dir="ltr" onClick={() => setDetailId(d.id)}>{d.mac}</button></td>
                      <td className="px-2 py-1.5">{d.category}</td>
                      <td className="px-2 py-1.5"><ConnBadge type={d.connectionType} /></td>
                      <td className="px-2 py-1.5 num" dir="ltr">{d.interface ?? d.ap ?? "—"}</td>
                      <td className="px-2 py-1.5">{d.router.name}</td>
                      <td className="px-2 py-1.5 text-[10px] text-[#8CA3C3]" dir="ltr">{d.lastSeen ? fmtDateTime(d.lastSeen) : "—"}</td>
                      <td className="px-2 py-1.5">
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-[#8CA3C3]" onClick={() => setDetailId(d.id)} aria-label="open">
                          <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-[#111C30] px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] text-[#64748B]">{fmtNum(total)} {lang === "ar" ? "جهاز" : "devices"}</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 text-[10px] border-[#1B2946]" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{lang === "ar" ? "السابق" : "Prev"}</Button>
                <span className="text-[10px] text-[#8CA3C3] px-2">{page}/{totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 text-[10px] border-[#1B2946]" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{lang === "ar" ? "التالي" : "Next"}</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* UNKNOWN DEVICES */}
      {tab === "unknown" && (
        <div className="space-y-3">
          <Alert className="!py-2 border-[#1B2946] bg-[#111C30]/60">
            <AlertDescription className="text-[11.5px] text-[#8CA3C3]" dir="auto">
              {lang === "ar"
                ? "الأجهزة المكتشفة حديثاً والتي لم تتم مراجعتها بعد. لا يعني «غير معروف» أنها ضارة — راجع ثم وصنّف أو توثّق أو حجب."
                : "Newly discovered devices that have not been reviewed yet. 'Unknown' does not mean malicious — review, then categorize, trust, or block."}
            </AlertDescription>
          </Alert>
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead className="bg-[#111C30]">
                  <tr className="text-[#8CA3C3]">
                    <th className="text-start px-2 py-2">{t("firstSeenCol")}</th>
                    <th className="text-start px-2 py-2">MAC</th>
                    <th className="text-start px-2 py-2">IP</th>
                    <th className="text-start px-2 py-2">{t("manufacturer")}</th>
                    <th className="text-start px-2 py-2">{t("interface")}</th>
                    <th className="text-start px-2 py-2">{t("vlan")}</th>
                    <th className="text-start px-2 py-2">{t("evidence")}</th>
                    <th className="text-start px-2 py-2">{t("status")}</th>
                    <th className="text-start px-2 py-2">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody className="text-[#E2E8F0]">
                  {!loading && unknownDevices.length === 0 && (
                    <tr><td colSpan={9} className="text-center py-10 text-[#64748B] text-[11px]" dir="auto">{lang === "ar" ? "لا توجد أجهزة جديدة بانتظار المراجعة" : "No new devices awaiting review"}</td></tr>
                  )}
                  {unknownDevices.map((d) => (
                    <tr key={d.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                      <td className="px-2 py-1.5 text-[10px] text-[#8CA3C3]" dir="ltr">{fmtDateTime(d.firstSeen)}</td>
                      <td className="px-2 py-1.5"><button className="text-[#22D3EE] hover:underline num" dir="ltr" onClick={() => setDetailId(d.id)}>{d.mac}</button></td>
                      <td className="px-2 py-1.5 num" dir="ltr">{d.ip ?? "—"}</td>
                      <td className="px-2 py-1.5" dir="ltr">{d.manufacturer ?? "—"}</td>
                      <td className="px-2 py-1.5 num" dir="ltr">{d.interface ?? d.ap ?? "—"}</td>
                      <td className="px-2 py-1.5 num" dir="ltr">{d.vlan ?? "—"}</td>
                      <td className="px-2 py-1.5"><div className="flex gap-1 flex-wrap">{d.sources.map((s) => <Badge key={s} variant="outline" className="text-[8px] border-[#1B2946] text-[#22D3EE] !px-1 !py-0" dir="ltr">{s}</Badge>)}</div></td>
                      <td className="px-2 py-1.5"><StatusDot status={d.status} label={t(statusKey(d.status))} /></td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-6 text-[9px] px-1.5 border-[#1B2946]" onClick={async () => { await api(`/api/devices/${d.id}/actions`, { method: "POST", json: { action: "trust" } }).then(refresh); }}>{t("trustDevice")}</Button>
                          <Button size="sm" variant="outline" className="h-6 text-[9px] px-1.5 border-[#1B2946]" onClick={() => setDetailId(d.id)}>{t("overview")}</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SOURCE TABLES */}
      {(tab === "dhcp_leases" || tab === "arp" || tab === "bridge_hosts" || tab === "wireless" || tab === "ppp_active") && (
        <SourceTable source={tab} routerId={routerId} openDevice={setDetailId} onChanged={refresh} />
      )}

      {/* LIVE HOTSPOT — Active / Hosts / Bindings straight from RouterOS */}
      {(tab === "hotspot_active" || tab === "hotspot_hosts" || tab === "hotspot_bindings") && (
        <HotspotLivePanel
          mode={tab === "hotspot_active" ? "active" : tab === "hotspot_hosts" ? "hosts" : "bindings"}
          routerId={routerId}
          openDevice={setDetailId}
        />
      )}

      {tab === "traffic" && <LiveTrafficPanel routerId={routerId} />}

      {tab === "resources" && <NetworkResourcesPanel routerId={routerId} onChanged={refresh} />}
      <DeviceDetailSheet deviceId={detailId} open={detailId !== null} onClose={() => setDetailId(null)} onChanged={refresh} />
    </div>
  );
}

function KpiCard({ icon, label, value, accent, live }: { icon: React.ReactNode; label: string; value: string; accent?: string; live?: boolean }) {
  return (
    <div className={`panel p-3.5 flex items-center gap-3 ${live ? "ring-1 ring-emerald-500/20" : ""}`}>
      <div className={`w-9 h-9 rounded-lg bg-[#111C30] flex items-center justify-center shrink-0 ${accent === "emerald" ? "!bg-emerald-950/50" : accent === "red" ? "!bg-red-950/50" : accent === "amber" ? "!bg-amber-950/50" : ""}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] text-[#64748B] truncate flex items-center gap-1" dir="auto">
          {live && (
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
            </span>
          )}
          <span className="truncate">{label}</span>
        </div>
        <div className="text-[18px] font-extrabold text-white num" dir="ltr">{value}</div>
      </div>
    </div>
  );
}

function ChartPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-3">
      <div className="text-[12px] font-bold text-[#CBD5E1] mb-2" dir="auto">{title}</div>
      {children}
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="h-[200px] flex flex-col items-center justify-center text-[#64748B] text-[11px] gap-2" dir="auto">
      <AlertTriangle className="w-5 h-5 text-[#F59E0B]/70" />
      {text}
    </div>
  );
}

function statusKey(status: string): DictKey {
  switch (status) {
    case "online": return "statusOnline";
    case "offline": return "statusOffline";
    case "idle": return "statusIdle";
    case "blocked": return "statusBlocked";
    case "recently_disconnected": return "statusRecentlyDisc";
    default: return "statusUnknown";
  }
}

function StatusDot({ status, label }: { status: string; label: string }) {
  const color =
    status === "online" ? "bg-emerald-500" : status === "offline" ? "bg-red-500" :
    status === "idle" ? "bg-sky-400" : status === "blocked" ? "bg-orange-500" :
    status === "recently_disconnected" ? "bg-amber-400" : "bg-slate-500";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`dot ${color} !w-2 !h-2`} />
      <span className="text-[10px] text-[#8CA3C3]" dir="auto">{label}</span>
    </span>
  );
}

function ConnBadge({ type }: { type: string }) {
  const map: Record<string, string> = { wired: "bg-[#1685FF]/20 text-[#1685FF]", wireless: "bg-[#22D3EE]/20 text-[#22D3EE]", hotspot: "bg-emerald-500/20 text-emerald-400", pppoe: "bg-[#8B5CF6]/20 text-[#A78BFA]", unknown: "bg-slate-500/20 text-slate-400" };
  return <Badge variant="outline" className={`text-[9px] !px-1.5 ${map[type] ?? map.unknown}`} dir="ltr">{type}</Badge>;
}

function Th2({ children }: { children: React.ReactNode }) {
  return <th className="text-start px-2 py-2">{children}</th>;
}
