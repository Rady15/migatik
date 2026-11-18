"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { useDeviceTraffic } from "@/hooks/use-realtime";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Activity, Zap } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

interface LivePayload {
  device: { id: string; mac: string; ipAddress: string | null; customName: string | null; hostname: string | null; status: string; connectionType: string };
  samples: { id: string; rxMbps: number; txMbps: number; source: string; ts: string }[];
  daily: { day: string; downMb: number; upMb: number }[];
  monthly: { month: string; downMb: number; upMb: number }[];
  topConsumers: { deviceId: string; label: string; totalMbps: number }[];
}

export function LiveTrafficPanel({ routerId }: { routerId: string }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [devices, setDevices] = useState<{ id: string; mac: string; ip: string | null; hostname: string | null; customName: string | null; status: string; lastSeen: string | null }[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [data, setData] = useState<LivePayload | null>(null);
  const [loading, setLoading] = useState(false);

  // device picker list — online devices first
  useEffect(() => {
    api<{ devices: typeof devices }>(`/api/devices?routerId=${routerId}&pageSize=100&sort=lastSeen&dir=desc`)
      .then((d) => setDevices(d.devices))
      .catch(() => {});
  }, [routerId]);

  const loadHistory = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    try {
      setData(await api<LivePayload>(`/api/devices/${deviceId}/live?minutes=30`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [deviceId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const { samples, mode } = useDeviceTraffic(deviceId);

  const liveData = samples.map((s) => ({
    time: new Date(s.ts).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    down: Number(s.rxMbps.toFixed(3)),
    up: Number(s.txMbps.toFixed(3)),
  }));
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const dailyData = data?.daily.map((d) => ({ day: d.day, down: Number((d.downMb / 1024).toFixed(2)), up: Number((d.upMb / 1024).toFixed(2)) })) ?? [];
  const monthlyData = data?.monthly.map((m) => ({ month: m.month, down: Number((m.downMb / 1024).toFixed(1)), up: Number((m.upMb / 1024).toFixed(1)) })) ?? [];

  const selected = devices.find((d) => d.id === deviceId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={deviceId ?? ""} onValueChange={(v) => setDeviceId(v)}>
          <SelectTrigger className="h-8 w-64 text-[11.5px] bg-[#111C30] border-[#1B2946]">
            <SelectValue placeholder={lang === "ar" ? "اختر جهازاً..." : "Select a device..."} />
          </SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946] max-h-72">
            {devices.map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-[11px]">
                {d.customName || d.hostname || d.mac} {d.ip ? `(${d.ip})` : ""} {d.status === "online" ? "●" : "○"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {latest && (
          <Badge variant="outline" className="text-[10px] border-[#1B2946] text-[#22D3EE]" dir="ltr">
            ↓ {latest.rxMbps.toFixed(2)} Mbps · ↑ {latest.txMbps.toFixed(2)} Mbps · {latest.source}
          </Badge>
        )}
        <Badge variant="outline" className="text-[10px] border-[#1B2946] text-[#8CA3C3]">
          <Activity className="w-3 h-3 me-1" />{mode === "socket" ? t("realtimeConnected") : t("realtimePolling")}
        </Badge>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={loadHistory} disabled={!deviceId || loading}>
          <Loader2 className={`w-3.5 h-3.5 me-1 ${loading ? "animate-spin" : ""}`} />{t("syncNow")}
        </Button>
      </div>

      {!deviceId && (
        <div className="panel p-10 text-center text-[#64748B] text-[12px]" dir="auto">
          {lang === "ar" ? "اختر جهازاً من القائمة لعرض استهلاكه لحظياً وسجله اليومي والشهري" : "Pick a device to view its live consumption and daily/monthly history"}
        </div>
      )}

      {deviceId && selected && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* live chart */}
          <div className="panel p-3 lg:col-span-2">
            <div className="text-[12px] font-bold text-[#CBD5E1] mb-1" dir="auto">
              {t("liveTraffic")} — <span dir="ltr" className="num">{selected.customName || selected.hostname || selected.mac}</span>
            </div>
            <div className="text-[9.5px] text-[#64748B] mb-2" dir="auto">
              {lang === "ar"
                ? "المصدر: عدادات جلسات Hotspot الحقيقية، مراقبة واجهة PPPoE، أو واجهة الجهاز إن كان وحده عليها — لا تُخترع أرقام"
                : "Source: real hotspot session counters, PPPoE interface monitor, or device interface when exclusive — no invented numbers"}
            </div>
            {liveData.length > 1 ? (
              <ResponsiveContainer width="100%" height={230}>
                <AreaChart data={liveData}>
                  <defs>
                    <linearGradient id="ld" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22D3EE" stopOpacity={0.4} /><stop offset="100%" stopColor="#22D3EE" stopOpacity={0} /></linearGradient>
                    <linearGradient id="lu" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1685FF" stopOpacity={0.4} /><stop offset="100%" stopColor="#1685FF" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fill: "#64748B", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#64748B", fontSize: 9 }} unit=" Mbps" width={70} />
                  <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Area type="monotone" dataKey="down" stroke="#22D3EE" fill="url(#ld)" name={t("downloadMbps")} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="up" stroke="#1685FF" fill="url(#lu)" name={t("uploadMbps")} strokeWidth={2} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[230px] flex items-center justify-center text-[#64748B] text-[11px]" dir="auto">{t("noRouterSync")}</div>
            )}
          </div>

          {/* top consumers */}
          <div className="panel p-3">
            <div className="text-[12px] font-bold text-[#CBD5E1] mb-2 flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-amber-400" />{t("topConsumers")}</div>
            {data && data.topConsumers.length > 0 ? (
              <div className="space-y-1.5">
                {data.topConsumers.map((c, i) => (
                  <button key={c.deviceId} onClick={() => setDeviceId(c.deviceId)} className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[11px] ${c.deviceId === deviceId ? "bg-[#1685FF]/20" : "bg-[#111C30] hover:bg-[#17243B]"}`}>
                    <span className="truncate text-[#E2E8F0]" dir="auto">{i + 1}. {c.label}</span>
                    <span className="text-[#22D3EE] num shrink-0" dir="ltr">{c.totalMbps.toFixed(2)} Mbps</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[#64748B] py-8 text-center" dir="auto">{t("noData")}</div>
            )}
          </div>

          {/* daily */}
          <div className="panel p-3 lg:col-span-2">
            <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">{t("dailyUsage")}</div>
            {dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={dailyData}>
                  <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={{ fill: "#64748B", fontSize: 9 }} tickFormatter={(v) => fmtDate(v).slice(5)} />
                  <YAxis tick={{ fill: "#64748B", fontSize: 9 }} unit=" GB" width={70} />
                  <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="down" fill="#22D3EE" name={t("download")} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="up" fill="#1685FF" name={t("upload")} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="h-[200px] flex items-center justify-center text-[#64748B] text-[11px]" dir="auto">{t("noData")}</div>}
          </div>

          {/* monthly */}
          <div className="panel p-3">
            <div className="text-[12px] font-bold text-[#CBD5E1] mb-2">{t("monthlyUsage")}</div>
            {monthlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={monthlyData}>
                  <CartesianGrid stroke="#1B2946" strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fill: "#64748B", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#64748B", fontSize: 9 }} unit=" GB" width={70} />
                  <ReTooltip contentStyle={{ background: "#111C30", border: "1px solid #1B2946", borderRadius: 8, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="down" fill="#22D3EE" name={t("download")} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="up" fill="#1685FF" name={t("upload")} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="h-[200px] flex items-center justify-center text-[#64748B] text-[11px]" dir="auto">{t("noData")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
