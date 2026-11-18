"use client";

/**
 * Interactive Network Topology Map — design modeled on the reference NOC map:
 * dark canvas, device cards with IP / CPU / memory / uptime / status counters,
 * live bandwidth labels on links, left panel with IP addresses + device list,
 * toolbar with Scan / Add Device / Connect, zoom control.
 *
 * HONESTY: links are drawn only from real RouterOS observations (bridges,
 * wireless registrations, ARP/bridge interfaces). Anything not confirmed is
 * drawn dashed and labeled "inferred".
 *
 * Multi-router: inter-router LLDP/MNDP links shown as dashed purple router_link edges.
 * Path trace: click device → highlight path to Internet with cumulative bandwidth.
 * History: toolbar has history button to replay past snapshots.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DeviceDetailSheet } from "@/components/devices/device-detail-sheet";
import {
  Loader2, RefreshCw, Search, ZoomIn, ZoomOut, Maximize, Globe, Router as RouterIcon,
  Network, Wifi, Monitor, Plus, PlugZap, AlertTriangle, Boxes, History,
  TrendingUp, ExternalLink,
} from "lucide-react";

interface TopoNode {
  id: string; type: "internet" | "router" | "bridge" | "ap" | "port" | "device";
  label: string; ip?: string; mac?: string; cpu?: number; mem?: number; memTotal?: number;
  uptime?: string; version?: string; status?: string; online?: boolean;
  counts?: { ok: number; warn: number; err: number }; vlan?: number | null;
  deviceDbId?: string; connectionType?: string; manufacturer?: string; hostname?: string; category?: string;
}
interface TopoEdge { from: string; to: string; bandwidthMbps?: number; inferred: boolean; kind: string; label?: string }
interface RouterTopology {
  routerId: string; routerName: string; networkName: string;
  nodes: TopoNode[]; edges: TopoEdge[]; lastSyncAt: string | null;
  lastSyncOk: boolean | null; unreachable: boolean; statusMessage?: string | null;
}
interface MultiRouterTopology {
  routers: RouterTopology[];
  interRouterLinks: TopoEdge[];
  generatedAt: string;
}

interface Positioned {
  node: TopoNode; x: number; y: number; parentEdge?: TopoEdge;
}

const NODE_W = 148, NODE_H = 64, H_GAP = 24, LEVEL_H = 130;

function fmtBandwidth(mbps?: number): string | null {
  if (mbps == null) return null;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  if (mbps >= 1) return `${mbps.toFixed(0)} Mbps`;
  if (mbps >= 0.001) return `${(mbps * 1000).toFixed(0)} Kbps`;
  return `${mbps.toFixed(3)} Mbps`;
}

function fmtUptime(u?: string): string | null {
  return u ?? null;
}

export function TopologyView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [data, setData] = useState<MultiRouterTopology | null>(null);
  const [routerId, setRouterId] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(0.75);
  const [pan, setPan] = useState({ x: 60, y: 40 });
  const [search, setSearch] = useState("");
  const [hidePlaced, setHidePlaced] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [addForm, setAddForm] = useState({ mac: "", ip: "", hostname: "", server: "" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySnapshots, setHistorySnapshots] = useState<any[]>([]);
  const [selectedHistoryRouterId, setSelectedHistoryRouterId] = useState<string>("");
  const [pathTrace, setPathTrace] = useState<{ from: string; to: string; path: TopoNode[]; edges: TopoEdge[] } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const fitDoneRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<MultiRouterTopology>(`/api/network/topology?routerId=${routerId}&_=${Date.now()}`);
      setData(d);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setLoading(false); }
  }, [routerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 45000);
    return () => clearInterval(timer);
  }, [load]);

  const topo: RouterTopology | null = useMemo(() => {
    if (!data) return null;
    if (routerId !== "all") return data.routers.find((r) => r.routerId === routerId) ?? data.routers[0] ?? null;
    return data.routers[0] ?? null;
  }, [data, routerId]);

  // ---------- deterministic layout ----------
  const layout = useMemo(() => {
    if (!topo) return { nodes: [] as Positioned[], edges: [] as TopoEdge[], width: 800, height: 600, totalW: 800 };
    const byId = new Map(topo.nodes.map((n) => [n.id, n]));
    const children = new Map<string, string[]>();
    for (const e of topo.edges) {
      if (!children.has(e.from)) children.set(e.from, []);
      children.get(e.from)!.push(e.to);
    }
    const rootIds = topo.nodes.filter((n) => n.type === "internet" || (n.type === "router" && !topo.edges.some((e) => e.to === n.id))).map((n) => n.id);
    const positioned: Positioned[] = [];
    const placed = new Set<string>();
    let maxW = 0;

    const place = (id: string, level: number, xOffset: number): number => {
      const node = byId.get(id);
      if (!node || placed.has(id)) return xOffset;
      placed.add(id);
      const kids = (children.get(id) ?? []).filter((c) => byId.get(c));
      let x = xOffset;
      const y = 30 + level * LEVEL_H;
      if (kids.length === 0) {
        positioned.push({ node, x, y });
        return x + NODE_W + H_GAP;
      }
      let start = x;
      let total = 0;
      for (const k of kids) {
        const nx = place(k, level + 1, start);
        total = Math.max(total, nx - start);
        start = nx;
      }
      const kidPositions = positioned.filter((p) => kids.includes(p.node.id));
      const minKidX = Math.min(...kidPositions.map((p) => p.x));
      const maxKidX = Math.max(...kidPositions.map((p) => p.x + NODE_W));
      const parentX = (minKidX + maxKidX) / 2 - NODE_W / 2;
      positioned.push({ node, x: parentX, y });
      return Math.max(start, x + NODE_W + H_GAP);
    };

    let cursor = 0;
    for (const root of rootIds) {
      cursor = place(root, 0, cursor) + 60;
    }
    const orphans = topo.nodes.filter((n) => !placed.has(n.id));
    let orphanX = 0;
    for (const o of orphans) {
      positioned.push({ node: o, x: orphanX, y: 30 + 5 * LEVEL_H });
      orphanX += NODE_W + H_GAP;
    }
    maxW = Math.max(cursor, orphanX);
    const maxLevel = Math.max(...positioned.map((p) => p.y)) + NODE_H + 60;
    const edgeById = new Map(topo.edges.map((e) => [e.to, e]));
    const withEdges = positioned.map((p) => ({ ...p, parentEdge: edgeById.get(p.node.id) }));
    return { nodes: withEdges, edges: topo.edges, width: maxW, height: Math.max(maxLevel, 600), totalW: maxW };
  }, [topo]);

  // auto-fit the canvas when the topology first becomes available
  useEffect(() => {
    if (topo && topo.nodes.length > 0 && !fitDoneRef.current) {
      fitDoneRef.current = true;
      const id = requestAnimationFrame(() => fitView());
      return () => cancelAnimationFrame(id);
    }
  }, [topo]);

  // ---------- stats chips (CoreBit-style) ----------
  const stats = useMemo(() => {
    const devices = topo?.nodes.filter((n) => n.type === "device") ?? [];
    const ok = devices.filter((d) => d.status === "online").length;
    const warn = devices.filter((d) => ["idle", "recently_disconnected", "unknown"].includes(d.status ?? "")).length;
    const err = devices.filter((d) => ["offline", "blocked"].includes(d.status ?? "")).length;
    return { ok, warn, err, total: devices.length };
  }, [topo]);

  // ---------- search highlight + left panel ----------
  const deviceNodes = useMemo(() => (topo?.nodes.filter((n) => n.type === "device") ?? []), [topo]);
  const filteredDevices = useMemo(() => {
    const s = search.toLowerCase();
    return deviceNodes.filter((d) =>
      !s || d.label.toLowerCase().includes(s) || (d.ip ?? "").includes(s) || (d.mac ?? "").toLowerCase().includes(s));
  }, [deviceNodes, search]);
  const leftList = useMemo(() => (hidePlaced ? [] : filteredDevices), [hidePlaced, filteredDevices]);

  // ---------- interactions ----------
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoom((z) => Math.min(2.5, Math.max(0.15, z * factor)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.panX + (e.clientX - dragRef.current.x), y: dragRef.current.panY + (e.clientY - dragRef.current.y) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const fitView = () => {
    const el = canvasRef.current;
    if (!el || layout.width <= 0) return;
    const z = Math.min((el.clientWidth - 40) / layout.width, 1.2);
    setZoom(Math.max(0.15, z));
    setPan({ x: 20, y: 20 });
  };

  const scan = async () => {
    setSyncing(true);
    try {
      await api("/api/discovery", { method: "POST", json: { routerId } });
      setToast({ msg: lang === "ar" ? "بدأ الفحص — ستتحدث الخريطة تلقائياً" : "Scan started — the map will refresh automatically", ok: true });
      setTimeout(load, 3000);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setSyncing(false); }
  };

  const connect = async () => {
    if (!topo) return;
    try {
      const res = await api<{ ok?: boolean; error?: string; latencyMs?: number }>(`/api/routers/${topo.routerId}/test`, { method: "POST", json: {} });
      setToast(res.ok !== false && !res.error
        ? { msg: `${lang === "ar" ? "تم الاتصال بنجاح" : "Connected"} (${res.latencyMs ?? 0}ms)`, ok: true }
        : { msg: res.error ?? "connection failed", ok: false });
      load();
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    }
  };

  const addStaticDevice = async () => {
    if (!topo) return;
    try {
      const res = await api<{ detail?: string }>("/api/network/action", {
        json: { action: "lease_add_static", routerId: topo.routerId, mac: addForm.mac, ip: addForm.ip, server: addForm.server || undefined, comment: addForm.hostname || "added from map" },
      });
      setToast({ msg: res.detail ?? "ok", ok: true });
      setAddOpen(false);
      setAddForm({ mac: "", ip: "", hostname: "", server: "" });
      scan();
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    }
  };

  const loadHistory = async (rId: string) => {
    setSelectedHistoryRouterId(rId);
    try {
      const res = await api<{ snapshots: any[] }>(`/api/network/topology?routerId=${rId}&history=1`);
      setHistorySnapshots(res.snapshots);
      setHistoryOpen(true);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    }
  };

  const loadSnapshot = async (snapshotId: string) => {
    try {
      const snap = await api<any>(`/api/network/topology?snapshotId=${snapshotId}`);
      setPathTrace({ from: "history", to: "snapshot", path: snap.snapshot.nodes, edges: snap.snapshot.edges });
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    }
    setHistoryOpen(false);
  };

  const tracePath = useCallback((deviceId: string) => {
    if (!topo) return;
    const targetNode = topo.nodes.find((n) => n.id === deviceId);
    if (!targetNode) return;

    // Find path from device to internet
    const byId = new Map(topo.nodes.map((n) => [n.id, n]));
    const edgeByTo = new Map(topo.edges.map((e) => [e.to, e]));
    const path: TopoNode[] = [];
    const pathEdges: TopoEdge[] = [];
    let current = targetNode;

    path.unshift(current);
    while (current) {
      const edge = edgeByTo.get(current.id);
      if (!edge) break;
      pathEdges.unshift(edge);
      const parent = byId.get(edge.from);
      if (!parent) break;
      path.unshift(parent);
      if (parent.type === "internet") break;
      current = parent;
    }

    setPathTrace({ from: targetNode.id, to: "internet", path, edges: pathEdges });
  }, [topo]);

  const clearPathTrace = () => setPathTrace(null);

  const nodeIcon = (n: TopoNode) => {
    switch (n.type) {
      case "internet": return <Globe className="w-4 h-4 text-[#22D3EE]" />;
      case "router": return <RouterIcon className="w-4 h-4 text-[#1685FF]" />;
      case "bridge": return <Network className="w-4 h-4 text-[#8B5CF6]" />;
      case "ap": return <Wifi className="w-4 h-4 text-[#22D3EE]" />;
      case "port": return <PlugZap className="w-4 h-4 text-[#F59E0B]" />;
      default: return <Monitor className="w-4 h-4 text-[#8CA3C3]" />;
    }
  };

  const statusColor = (n: TopoNode) => {
    if (n.type === "device") {
      switch (n.status) {
        case "online": return "#10B981";
        case "offline": return "#EF4444";
        case "idle": return "#38BDF8";
        case "blocked": return "#F97316";
        case "recently_disconnected": return "#FBBF24";
        default: return "#64748B";
      }
    }
    if (n.type === "router" || n.type === "ap" || n.type === "bridge" || n.type === "port") return n.online === false ? "#EF4444" : "#10B981";
    return "#22D3EE";
  };

  // Combine inter-router links from multi-router data
  const interRouterLinks = data?.interRouterLinks ?? [];
  const allEdges = useMemo(() => [...(layout.edges ?? []), ...interRouterLinks], [layout.edges, interRouterLinks]);

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-extrabold text-white flex items-center gap-2">
          <Network className="w-4.5 h-4.5 text-[#22D3EE]" />
          {t("topologyTitle")}
        </h2>
        <Select value={routerId} onValueChange={setRouterId}>
          <SelectTrigger className="h-8 w-52 text-[11.5px] bg-[#111C30] border-[#1B2946]">
            <SelectValue placeholder={topo?.networkName} />
          </SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946]">
            <SelectItem key="all" value="all" className="text-[11.5px]" dir="ltr">{lang === "ar" ? "كل الراوترات" : "All Routers"}</SelectItem>
            {(data?.routers ?? []).map((r) => (
              <SelectItem key={r.routerId} value={r.routerId} className="text-[11.5px]" dir="ltr">{r.networkName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[12px] font-bold text-[#22D3EE] truncate max-w-[200px]" dir="ltr">{topo?.networkName ?? ""}</span>
        {/* CoreBit-style stats chips */}
        <Badge className="text-[10px] bg-emerald-950/60 text-emerald-300 border border-emerald-800/40" dir="ltr">{fmtNum(stats.ok)} ok</Badge>
        <Badge className="text-[10px] bg-amber-950/60 text-amber-300 border border-amber-800/40" dir="ltr">{fmtNum(stats.warn)} warn</Badge>
        <Badge className="text-[10px] bg-red-950/60 text-red-300 border border-red-800/40" dir="ltr">{fmtNum(stats.err)} err</Badge>
        <Button size="sm" className="h-8 text-[11px]" onClick={scan} disabled={syncing}>
          {syncing ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 me-1" />}{t("scanNetwork")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => setAddOpen(true)} disabled={!topo || topo.unreachable}>
          <Plus className="w-3.5 h-3.5 me-1" />{t("addDeviceBtn")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={connect} disabled={!topo}>
          <PlugZap className="w-3.5 h-3.5 me-1" />{t("connectBtn")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => loadHistory(topo?.routerId ?? "")} disabled={!topo}>
          <History className="w-3.5 h-3.5 me-1" />{t("history")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={() => {
          if (data) api(`/api/network/topology?routerId=${routerId}&save=1`, { method: "GET" }).then(() =>
            setToast({ msg: lang === "ar" ? "تم حفظ اللقطة" : "Snapshot saved", ok: true })
          );
        }}>
          <ExternalLink className="w-3.5 h-3.5 me-1" />{t("saveSnapshot")}
        </Button>
        <div className="relative min-w-[140px] flex-1 max-w-[240px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("search")} className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-[#8CA3C3]" onClick={() => setZoom((z) => Math.min(2.5, z * 1.15))} aria-label="zoom in"><ZoomIn className="w-4 h-4" /></Button>
          <span className="text-[11px] text-[#8CA3C3] w-10 text-center num" dir="ltr">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-[#8CA3C3]" onClick={() => setZoom((z) => Math.max(0.15, z * 0.87))} aria-label="zoom out"><ZoomOut className="w-4 h-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-[#8CA3C3]" onClick={fitView} aria-label="fit"><Maximize className="w-4 h-4" /></Button>
        </div>
      </div>

      {toast && (
        <Alert className={`!py-2 ${toast.ok ? "border-emerald-700/50 bg-emerald-950/30" : "border-red-800/50 bg-red-950/30"}`}>
          <AlertDescription className={`text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">{toast.msg}</AlertDescription>
        </Alert>
      )}

      {topo?.unreachable && (
        <Alert className="!py-2 border-amber-800/50 bg-amber-950/20">
          <AlertDescription className="text-[11.5px] text-amber-300 flex items-center gap-1.5" dir="auto">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{t("routerOfflineNote")}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-3 items-stretch">
        {/* left panel */}
        <div className="panel p-3 w-56 shrink-0 hidden md:flex flex-col max-h-[560px]">
          <div className="text-[11px] font-bold text-[#CBD5E1] mb-2 flex items-center justify-between" dir="ltr">
            <span>IP Addresses ({filteredDevices.filter((d) => d.ip).length})</span>
          </div>
          <label className="flex items-center gap-2 mb-2 cursor-pointer">
            <Checkbox checked={hidePlaced} onCheckedChange={(v) => setHidePlaced(v === true)} />
            <span className="text-[10px] text-[#8CA3C3]">{t("hidePlaced")}</span>
          </label>
          <div className="flex-1 overflow-y-auto space-y-1">
            {leftList.map((d) => (
              <button key={d.id} onClick={() => d.deviceDbId && setDetailId(d.deviceDbId)}
                className="w-full flex items-center justify-between gap-1.5 rounded px-1.5 py-1 hover:bg-[#17243B] text-[10px]">
                <span className="text-[#CBD5E1] truncate text-start" dir="auto">{d.label}</span>
                <span className="text-[#64748B] num shrink-0" dir="ltr">{d.ip ?? d.mac}</span>
              </button>
            ))}
            {leftList.length === 0 && <div className="text-[10px] text-[#64748B] py-4 text-center" dir="auto">{hidePlaced ? t("hidePlaced") + " ✓" : t("noData")}</div>}
          </div>
          <div className="text-[9px] text-[#4C5F80] mt-2 flex items-center gap-1">
            <Boxes className="w-3 h-3" />{stats.total} {lang === "ar" ? "جهاز" : "devices"}
          </div>
        </div>

        {/* canvas */}
        <div
          ref={canvasRef}
          className="panel flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing min-h-[560px]"
          style={{ background: "radial-gradient(ellipse at 50% 0%, #0D1A32 0%, #0A1020 70%)" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="application"
          aria-label="network topology map"
        >
          {loading && !topo ? (
            <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-[#1685FF]" /></div>
          ) : !topo ? (
            <div className="absolute inset-0 flex items-center justify-center text-[#64748B] text-[12px]" dir="auto">{t("noRouterSync")}</div>
          ) : (
            <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", width: layout.width + 200, height: layout.height + 200, position: "relative" }}>
              <svg width={layout.width + 200} height={layout.height + 200} className="absolute inset-0" style={{ pointerEvents: "none" }}>
                {allEdges.map((edge) => {
                  const fromNode = layout.nodes.find((q) => q.node.id === edge.from);
                  const toNode = layout.nodes.find((q) => q.node.id === edge.to);
                  if (!fromNode || !toNode) return null;
                  const x1 = fromNode.x + NODE_W / 2, y1 = fromNode.y + NODE_H;
                  const x2 = toNode.x + NODE_W / 2, y2 = toNode.y;
                  const midY = (y1 + y2) / 2;
                  const bw = fmtBandwidth(edge.bandwidthMbps);
                  const inferred = edge.inferred;
                  const isRouterLink = edge.kind === "router_link";
                  const isPathTrace = pathTrace?.edges.some((e) => e.from === edge.from && e.to === edge.to);

                  return (
                    <g key={`e-${edge.from}-${edge.to}`}>
                      <path d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                        fill="none"
                        stroke={isPathTrace ? "#10B981" : isRouterLink ? "#8B5CF6" : inferred ? "#334155" : edge.kind === "wan" ? "#22D3EE" : "#2E4A73"}
                        strokeWidth={isPathTrace ? 3 : isRouterLink ? 2 : edge.kind === "wan" ? 2.4 : 1.4}
                        strokeDasharray={isRouterLink ? "8 4" : inferred ? "5 4" : undefined}
                        opacity={isPathTrace ? 1 : isRouterLink ? 0.8 : inferred ? 0.7 : 0.9} />
                      {bw && !isRouterLink && (
                        <text x={(x1 + x2) / 2} y={midY - 4} fill="#22D3EE" fontSize={9.5} textAnchor="middle" opacity={0.95} style={{ paintOrder: "stroke", stroke: "#0A1020", strokeWidth: 3 }}>
                          {bw}
                        </text>
                      )}
                      {inferred && !isPathTrace && !isRouterLink && (
                        <text x={(x1 + x2) / 2} y={midY + 10} fill="#475569" fontSize={8} textAnchor="middle" style={{ paintOrder: "stroke", stroke: "#0A1020", strokeWidth: 3 }}>
                          inferred
                        </text>
                      )}
                      {isRouterLink && (
                        <text x={(x1 + x2) / 2} y={midY - 8} fill="#8B5CF6" fontSize={8} textAnchor="middle" fontWeight="bold" style={{ paintOrder: "stroke", stroke: "#0A1020", strokeWidth: 3 }}>
                          {edge.label || "LLDP/MNDP"}
                        </text>
                      )}
                      {edge.label && !isRouterLink && (
                        <text x={x2} y={y2 - 6} fill="#64748B" fontSize={8.5} textAnchor="middle" style={{ paintOrder: "stroke", stroke: "#0A1020", strokeWidth: 3 }}>
                          {edge.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                {/* Path trace highlight overlay */}
                {pathTrace && pathTrace.path.length > 0 && (
                  <g>
                    {pathTrace.path.slice(1).map((node, i) => {
                      const edge = pathTrace.edges[i];
                      if (!edge) return null;
                      const fromNode = layout.nodes.find((q) => q.node.id === edge.from);
                      const toNode = layout.nodes.find((q) => q.node.id === edge.to);
                      if (!fromNode || !toNode) return null;
                      const x1 = fromNode.x + NODE_W / 2, y1 = fromNode.y + NODE_H;
                      const x2 = toNode.x + NODE_W / 2, y2 = toNode.y;
                      return (
                        <path key={`pt-${edge.from}-${edge.to}`} d={`M ${x1} ${y1} C ${x1} ${(y1+y2)/2}, ${x2} ${(y1+y2)/2}, ${x2} ${y2}`}
                          fill="none" stroke="#10B981" strokeWidth={4} strokeDasharray="8 4" opacity={0.9}
                          filter="drop-shadow(0 0 4px #10B981)" />
                      );
                    })}
                  </g>
                )}
              </svg>
              {layout.nodes.map((p) => {
                const isInPath = pathTrace?.path.some((n) => n.id === p.node.id);
                return (
                  <div
                    key={p.node.id}
                    data-node
                    className="absolute rounded-lg border bg-[#101B31] hover:bg-[#14213A] transition-all duration-150 shadow-lg cursor-pointer select-none"
                    style={{
                      left: p.x, top: p.y, width: NODE_W, height: NODE_H,
                      borderColor: isInPath ? "#10B981" : p.node.type === "device" ? "rgba(96,128,180,0.35)" : `${statusColor(p.node)}66`,
                      boxShadow: isInPath ? "0 0 20px #10B98188" : p.node.type !== "device" ? `0 0 14px ${statusColor(p.node)}22` : undefined,
                      transform: isInPath ? "scale(1.05)" : undefined,
                    }}
                    onClick={() => {
                      if (p.node.type === "device") tracePath(p.node.id);
                      else p.node.deviceDbId && setDetailId(p.node.deviceDbId);
                    }}
                    onDoubleClick={() => {
                      if (p.node.type !== "device" && p.node.deviceDbId) setDetailId(p.node.deviceDbId);
                    }}
                    title={p.node.label}
                  >
                    <div className="flex items-center gap-1.5 px-2 pt-1.5">
                      {nodeIcon(p.node)}
                      <span className="text-[10px] font-bold text-white truncate" dir="ltr">{p.node.label}</span>
                    </div>
                    <div className="px-2 text-[8.5px] text-[#64748B] num truncate" dir="ltr">{p.node.ip ?? p.node.mac ?? ""}</div>
                    {p.node.type === "router" && (p.node.cpu != null || p.node.mem != null) && (
                      <div className="px-2 flex gap-1 mt-0.5">
                        {p.node.cpu != null && <MiniBar label={`CPU ${p.node.cpu}%`} value={p.node.cpu} color={p.node.cpu > 70 ? "#EF4444" : "#10B981"} />}
                        {p.node.mem != null && <MiniBar label={`MEM ${p.node.mem}%`} value={p.node.mem} color={p.node.mem > 80 ? "#EF4444" : "#1685FF"} />}
                      </div>
                    )}
                    {p.node.type === "router" && p.node.uptime && (
                      <div className="px-2 text-[8px] text-[#4C5F80] num" dir="ltr">up {p.node.uptime}{p.node.version ? ` · v${p.node.version}` : ""}</div>
                    )}
                    {p.node.type === "device" && p.node.manufacturer && (
                      <div className="px-2 text-[8px] text-[#4C5F80] truncate" dir="ltr">{p.node.manufacturer}</div>
                    )}
                    {p.node.counts && (p.node.counts.ok + p.node.counts.warn + p.node.counts.err > 0) && (
                      <div className="absolute -top-1.5 -end-1.5 flex gap-0.5">
                        {p.node.counts.ok > 0 && <span className="rounded-full bg-emerald-600 text-white text-[8px] px-1.5 py-px num" dir="ltr">{p.node.counts.ok}</span>}
                        {p.node.counts.warn > 0 && <span className="rounded-full bg-amber-500 text-black text-[8px] px-1.5 py-px num" dir="ltr">{p.node.counts.warn}</span>}
                        {p.node.counts.err > 0 && <span className="rounded-full bg-red-600 text-white text-[8px] px-1.5 py-px num" dir="ltr">{p.node.counts.err}</span>}
                      </div>
                    )}
                    {p.node.type === "device" && (
                      <span className="absolute top-1.5 end-1.5 w-2 h-2 rounded-full" style={{ background: isInPath ? "#10B981" : statusColor(p.node) }} />
                    )}
                    {p.node.vlan != null && (
                      <span className="absolute bottom-1 end-1.5 text-[7.5px] text-[#8B5CF6] num" dir="ltr">VLAN {p.node.vlan}</span>
                    )}
                    {isInPath && (
                      <div className="absolute -bottom-5 start-1/2 -translate-x-1/2 text-[8px] text-[#10B981] font-bold bg-[#0A1020] px-1.5 py-0.5 rounded whitespace-nowrap shadow-lg" dir="ltr">
                        {lang === "ar" ? "مسار إلى الإنترنت" : "Path to Internet"}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* legend */}
              <div className="absolute bottom-2 start-2 bg-[#0A1020]/85 border border-[#1B2946] rounded-lg px-2.5 py-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[8.5px] text-[#8CA3C3]" style={{ pointerEvents: "none" }}>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />online</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" />idle</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />offline/blocked</span>
                <span className="flex items-center gap-1"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#334155" strokeWidth="1.4" strokeDasharray="4 3" /></svg>{t("topologyInferred")}</span>
                <span className="flex items-center gap-1"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="8 4" /></svg>{lang === "ar" ? "رابط بين الراوترات" : "Router Link"}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" style={{ boxShadow: "0 0 6px #10B981" }} />{lang === "ar" ? "مسار" : "Path"}</span>
              </div>
              {topo.lastSyncAt && (
                <div className="absolute top-2 end-2 text-[9px] text-[#4C5F80] num" dir="ltr" style={{ pointerEvents: "none" }}>
                  sync: {new Date(topo.lastSyncAt).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <DeviceDetailSheet deviceId={detailId} open={detailId !== null} onClose={() => setDetailId(null)} onChanged={load} />

      {/* add device dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#1B2946] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-[14px]">{t("addStaticLease")}</DialogTitle></DialogHeader>
          <div className="space-y-2.5 text-[12px]">
            <Input placeholder="MAC (AA:BB:CC:DD:EE:FF)" value={addForm.mac} onChange={(e) => setAddForm({ ...addForm, mac: e.target.value })} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946] num" dir="ltr" />
            <Input placeholder="IP (192.168.1.x)" value={addForm.ip} onChange={(e) => setAddForm({ ...addForm, ip: e.target.value })} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946] num" dir="ltr" />
            <Input placeholder={lang === "ar" ? "اسم الجهاز (اختياري)" : "Hostname (optional)"} value={addForm.hostname} onChange={(e) => setAddForm({ ...addForm, hostname: e.target.value })} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]" />
            <Input placeholder={lang === "ar" ? "خادم DHCP (اختياري)" : "DHCP server (optional)"} value={addForm.server} onChange={(e) => setAddForm({ ...addForm, server: e.target.value })} className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]" dir="ltr" />
            <p className="text-[10px] text-[#64748B]" dir="auto">{lang === "ar" ? "سيُنشئ حجزاً ثابتاً على السيرفر عبر RouterOS API ثم يُعاد الفحص ليظهر على الخريطة." : "Creates a static lease on the router via the RouterOS API, then a scan places it on the map."}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-8 text-[11px] border-[#1B2946]" onClick={() => setAddOpen(false)}>{t("cancel")}</Button>
              <Button size="sm" className="h-8 text-[11px]" onClick={addStaticDevice}>{t("add")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* history dialog */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#1B2946] text-[#F1F5F9] max-w-lg">
          <DialogHeader><DialogTitle className="text-[14px]">{lang === "ar" ? "سجل اللقطات" : "Topology History"}</DialogTitle></DialogHeader>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {historySnapshots.length === 0 ? (
              <p className="text-[12px] text-[#64748B] text-center py-8">{lang === "ar" ? "لا توجد لقطات محفوظة" : "No saved snapshots"}</p>
            ) : (
              historySnapshots.map((s) => (
                <Button
                  key={s.id}
                  variant="outline"
                  className="w-full justify-start h-9 text-[11px] border-[#1B2946] text-start"
                  onClick={() => loadSnapshot(s.id)}
                >
                  <History className="w-3.5 h-3.5 me-1" />
                  {new Date(s.ts).toLocaleString()} ({s.snapshot?.nodes?.length ?? 0} {lang === "ar" ? "عقدة" : "nodes"})
                </Button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* path trace info banner */}
      {pathTrace && (
        <Alert className="!py-2 border-emerald-700/50 bg-emerald-950/30 flex items-center justify-between">
          <AlertDescription className="text-[12px] text-emerald-300 flex items-center gap-2" dir="auto">
            <TrendingUp className="w-4 h-4" />
            <span>{lang === "ar" ? "مسار إلى الإنترنت:" : "Path to Internet:"}</span>
            <span className="text-emerald-200 font-mono">{pathTrace.path.map((n) => n.label).join(" → ")}</span>
          </AlertDescription>
          <Button variant="ghost" size="sm" onClick={clearPathTrace}>{lang === "ar" ? "مسح المسار" : "Clear Path"}</Button>
        </Alert>
      )}
    </div>
  );
}

function MiniBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="h-1 rounded-full bg-[#1B2946] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, background: color }} />
      </div>
      <div className="text-[7px] text-[#4C5F80] num mt-px" dir="ltr">{label}</div>
    </div>
  );
}