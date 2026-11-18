"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDateTime, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, RefreshCw, Search, Server, Clock, CheckCircle2, XCircle } from "lucide-react";

interface RouterInfo { id: string; name: string; host: string; status: string; lastSyncAt: string | null; lastSyncOk: boolean | null; lastSyncError: string | null; syncEnabled: boolean; syncIntervalSec: number; isDemo: boolean }
interface JobRow {
  id: string; router: string; routerId: string; type: string; trigger: string; status: string;
  sourcesDone: string[]; sourcesFailed: string[]; stats: Record<string, unknown>;
  error: string | null; durationMs: number | null; startedAt: string; finishedAt: string | null;
}

const RESOURCE_SOURCES = ["interfaces", "addresses", "dhcp_servers", "dhcp_networks", "neighbors", "routes", "firewall_connections", "address_lists"] as const;

export function NetworkResourcesPanel({ routerId, onChanged }: { routerId: string; onChanged?: () => void }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [source, setSource] = useState<(typeof RESOURCE_SOURCES)[number]>("interfaces");
  const [rows, setRows] = useState<{ id: string; routerId: string; router: string; key: string; data: Record<string, string>; syncTime: string }[]>([]);
  const [routers, setRouters] = useState<RouterInfo[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<{ discovery_grace_min: string; discovery_notify_new: string; discovery_notify_offline: string; discovery_interface_traffic: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [net, disc, st] = await Promise.all([
        api<{ rows: typeof rows; routers: RouterInfo[] }>(`/api/network?source=${source}&routerId=${routerId}&_=${Date.now()}`),
        api<{ jobs: JobRow[]; routers: RouterInfo[] }>("/api/discovery"),
        api<{ settings: typeof settings }>("/api/discovery/settings"),
      ]);
      setRows(net.rows);
      setRouters(disc.routers);
      setJobs(disc.jobs);
      setSettings(st.settings);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [source, routerId]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api("/api/discovery/settings", { method: "PUT", json: patch });
      onChanged?.();
    } catch { /* ignore */ } finally { setBusy(false); }
  };

  const filtered = search
    ? rows.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search.toLowerCase()) || r.key.toLowerCase().includes(search.toLowerCase()))
    : rows;

  return (
    <div className="space-y-4">
      {/* router sync health */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {routers.map((r) => (
          <div key={r.id} className="panel p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Server className="w-4 h-4 text-[#1685FF] shrink-0" />
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-white truncate" dir="ltr">{r.name}</div>
                  <div className="text-[9.5px] text-[#64748B] num" dir="ltr">{r.host}</div>
                </div>
              </div>
              <Badge className={r.status === "online" ? "text-[9px] bg-emerald-600 text-white" : "text-[9px] bg-red-600 text-white"}>{r.status}</Badge>
            </div>
            <div className="flex items-center justify-between text-[10px] text-[#8CA3C3]">
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : t("neverSynced")}</span>
              {r.lastSyncOk === false ? <XCircle className="w-3.5 h-3.5 text-red-400" /> : r.lastSyncOk === true ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : null}
            </div>
            {r.lastSyncError && <div className="text-[9.5px] text-red-300 truncate" dir="auto">{r.lastSyncError}</div>}
            <div className="flex items-center gap-2">
              <Switch checked={r.syncEnabled} disabled aria-label="sync enabled" />
              <span className="text-[9.5px] text-[#64748B]">{t("syncInterval")}: {r.syncIntervalSec}s</span>
            </div>
          </div>
        ))}
      </div>

      {/* discovery settings */}
      {settings && (
        <div className="panel p-3 space-y-2.5">
          <div className="text-[12px] font-bold text-[#CBD5E1]">{t("syncSettings")}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-[11px]">
            <label className="flex items-center gap-2">
              <span className="text-[#8CA3C3] shrink-0" dir="auto">{t("gracePeriod")}</span>
              <Input type="number" min={1} max={60} defaultValue={settings.discovery_grace_min}
                onBlur={(e) => saveSettings({ discovery_grace_min: e.target.value })}
                className="h-7 text-[11px] bg-[#111C30] border-[#1B2946] w-16" />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[#8CA3C3]" dir="auto">{t("notifyNew")}</span>
              <Switch checked={settings.discovery_notify_new !== "false"} onCheckedChange={(v) => { setSettings({ ...settings, discovery_notify_new: String(v) }); saveSettings({ discovery_notify_new: String(v) }); }} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[#8CA3C3]" dir="auto">{t("notifyOffline")}</span>
              <Switch checked={settings.discovery_notify_offline === "true"} onCheckedChange={(v) => { setSettings({ ...settings, discovery_notify_offline: String(v) }); saveSettings({ discovery_notify_offline: String(v) }); }} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[#8CA3C3]" dir="auto">{t("ifaceTraffic")}</span>
              <Switch checked={settings.discovery_interface_traffic !== "false"} onCheckedChange={(v) => { setSettings({ ...settings, discovery_interface_traffic: String(v) }); saveSettings({ discovery_interface_traffic: String(v) }); }} />
            </label>
          </div>
        </div>
      )}

      {/* recent sync jobs */}
      <div className="panel p-3">
        <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">{t("discoveryJobs")}</div>
        <div className="space-y-1 max-h-44 overflow-y-auto">
          {jobs.length === 0 && <div className="text-[11px] text-[#64748B]">{t("noData")}</div>}
          {jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-baseline gap-2 text-[10.5px] border-b border-[#1B2946]/50 pb-1">
              <span className="text-[#64748B] w-32 shrink-0" dir="ltr">{fmtDateTime(j.startedAt)}</span>
              <Badge className={`text-[8.5px] ${j.status === "success" ? "bg-emerald-600 text-white" : j.status === "partial" ? "bg-amber-600 text-white" : j.status === "running" ? "bg-sky-600 text-white" : "bg-red-600 text-white"}`}>{j.status}</Badge>
              <span className="text-[#E2E8F0]">{j.router}</span>
              <span className="text-[#64748B]" dir="auto">{t("sourcesDone")}: {(j.sourcesDone ?? []).length}</span>
              {(j.sourcesFailed ?? []).length > 0 && <span className="text-red-300" dir="auto">{t("sourcesFailed")}: {j.sourcesFailed.join(", ")}</span>}
              {j.durationMs != null && <span className="text-[#64748B] num" dir="ltr">{j.durationMs}ms</span>}
            </div>
          ))}
        </div>
      </div>

      {/* resource source browser */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
          <SelectTrigger className="h-8 w-52 text-[11px] bg-[#111C30] border-[#1B2946]"><SelectValue /></SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946]">
            {RESOURCE_SOURCES.map((s) => <SelectItem key={s} value={s} className="text-[11px]" dir="ltr">{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("search")} className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 me-1 ${loading ? "animate-spin" : ""}`} />{t("syncNow")}
        </Button>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-[#111C30] sticky top-0">
              <tr className="text-[#8CA3C3]">
                <th className="text-start px-2.5 py-2">{t("router")}</th>
                <th className="text-start px-2.5 py-2">key</th>
                <th className="text-start px-2.5 py-2">data</th>
                <th className="text-start px-2.5 py-2">{t("lastSync")}</th>
              </tr>
            </thead>
            <tbody className="text-[#E2E8F0]">
              {loading && rows.length === 0 && <tr><td colSpan={4} className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin text-[#1685FF] mx-auto" /></td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-[#64748B] text-[11px]" dir="auto">{t("noData")}</td></tr>}
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60 align-top">
                  <td className="px-2.5 py-1.5">{r.router}</td>
                  <td className="px-2.5 py-1.5 num text-[#22D3EE]" dir="ltr">{r.key}</td>
                  <td className="px-2.5 py-1.5"><pre className="text-[9px] text-[#8CA3C3] whitespace-pre-wrap max-w-[420px] max-h-16 overflow-hidden" dir="ltr">{JSON.stringify(r.data, null, 1)}</pre></td>
                  <td className="px-2.5 py-1.5 text-[10px] text-[#64748B]" dir="ltr">{fmtDateTime(r.syncTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
