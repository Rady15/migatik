"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtDateTime } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { Activity, Wifi } from "lucide-react";

interface SessionRow {
  id: string; username: string; ip: string | null; mac: string | null; routerName: string;
  startedAt: string; durationSec: number; uploadMb: number; downloadMb: number; speed: string;
}

export function MonitoringView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [network, setNetwork] = useState<{ time: string; download: number; upload: number; users: number }[]>([]);
  const [routerF, setRouterF] = useState("all");

  const load = useCallback(() => {
    api<{ sessions: SessionRow[] }>(`/api/sessions?routerId=${routerF}`)
      .then((d) => setSessions(d.sessions))
      .catch((e) => toast.error((e as Error).message));
    api<{ network: typeof network }>(`/api/dashboard?routerId=${routerF}`)
      .then((d) => setNetwork(d.network))
      .catch(() => {});
  }, [routerF]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const totalDl = network.reduce((a, p) => a + p.download, 0) / Math.max(1, network.length);
  const totalUl = network.reduce((a, p) => a + p.upload, 0) / Math.max(1, network.length);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("monitoring")}</h1>
        <RouterSelect value={routerF} onChange={setRouterF} className="w-56" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <StatTile icon={<Activity className="w-4 h-4 text-emerald-400" />} label={lang === "ar" ? "متوسط التحميل" : "Avg download"} value={`${totalDl.toFixed(1)} Mbps`} />
        <StatTile icon={<Activity className="w-4 h-4 text-blue-400" />} label={lang === "ar" ? "متوسط الرفع" : "Avg upload"} value={`${totalUl.toFixed(1)} Mbps`} />
        <StatTile icon={<Wifi className="w-4 h-4 text-cyan-400" />} label={t("activeSessions")} value={String(sessions?.length ?? "—")} />
        <StatTile icon={<Activity className="w-4 h-4 text-violet-400" />} label={lang === "ar" ? "إجمالي المستخدمين الحاليين" : "Users on chart"} value={String(network.at(-1)?.users ?? "—")} />
      </div>

      <div className="panel p-4" dir="ltr">
        <div className="text-center panel-title text-white mb-2" dir="rtl">{t("bandwidth")} — 24h</div>
        <div className="h-56">
          {network.length === 0 ? (
            <Skeleton className="h-full rounded-lg bg-[#111C33]" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={network} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1685FF" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#1685FF" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ulGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10B981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(96,128,180,0.12)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#8CA3C3", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "rgba(96,128,180,0.25)" }} minTickGap={30} />
                <YAxis tick={{ fill: "#8CA3C3", fontSize: 10 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={{ background: "#0D1729", border: "1px solid #24344F", borderRadius: 10, fontSize: 11, color: "#F1F5F9" }} />
                <Area type="monotone" dataKey="download" stroke="#1685FF" strokeWidth={2} fill="url(#dlGrad)" />
                <Area type="monotone" dataKey="upload" stroke="#10B981" strokeWidth={2} fill="url(#ulGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1B2946] flex items-center gap-2">
          <Wifi className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-extrabold text-white">{t("activeSessions")}</span>
          <span className="text-[11px] text-[#8CA3C3] num">({sessions?.length ?? 0})</span>
        </div>
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="mt-table w-full min-w-[760px]">
            <thead className="sticky top-0 bg-[#0E1A31]">
              <tr>
                <th>{t("username")}</th>
                <th>{t("ip")}</th>
                <th>{t("mac")}</th>
                <th>{t("router")}</th>
                <th>{t("speed")}</th>
                <th>{t("duration")}</th>
                <th>{lang === "ar" ? "البيانات (MB)" : "Data (MB)"}</th>
                <th>{t("date")}</th>
              </tr>
            </thead>
            <tbody>
              {!sessions && <tr><td colSpan={8} className="text-center text-[#64748B] py-8">{t("loading")}</td></tr>}
              {sessions && sessions.length === 0 && <tr><td colSpan={8} className="text-center text-[#64748B] py-8">{t("noData")}</td></tr>}
              {sessions?.map((s) => (
                <tr key={s.id} className="hover:bg-[#121E38]/70 transition-colors">
                  <td className="font-bold text-[#E2E8F0]">{s.username}</td>
                  <td className="num text-[#CBD5E1]" dir="ltr">{s.ip ?? "—"}</td>
                  <td className="num text-[#8CA3C3] text-[10.5px]" dir="ltr">{s.mac ?? "—"}</td>
                  <td className="text-[#CBD5E1]" dir="ltr">{s.routerName}</td>
                  <td className="num text-[#CBD5E1]" dir="ltr">{s.speed}</td>
                  <td className="num text-[#8CA3C3]" dir="ltr">{Math.floor(s.durationSec / 60)}m</td>
                  <td className="num text-[#8CA3C3]" dir="ltr">↑{Math.round(s.uploadMb)} ↓{Math.round(s.downloadMb)}</td>
                  <td className="num text-[#8CA3C3] text-[10.5px]" dir="ltr">{fmtDateTime(s.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="panel p-3 flex items-center gap-2.5">
      <div className="w-9 h-9 rounded-lg bg-[#0B1428] border border-[#1B2946]/60 flex items-center justify-center">{icon}</div>
      <div>
        <div className="text-[10px] text-[#8CA3C3]">{label}</div>
        <div className="text-sm font-extrabold text-white num" dir="ltr">{value}</div>
      </div>
    </div>
  );
}
