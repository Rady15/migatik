"use client";

import { useEffect, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { Users, MonitorSmartphone, Link2, Activity, Router } from "lucide-react";

interface LivePayload {
  active: {
    id: string; routerName: string; user: string; address: string | null; mac: string | null;
    uptime: string | null; bytesIn: number; bytesOut: number; server: string | null;
  }[];
  hosts: { id: string }[];
  bindings: { id: string; connected: boolean }[];
  counts: { active: number; hosts: number; bindings: number; connectedBindings: number };
  errors: { router: string; error: string }[];
  fetchedAt: string;
}

/**
 * Dashboard live strip: Active / Hosts / Bindings read directly from the router
 * every 3 seconds, plus the currently connected hotspot sessions.
 * Disconnected devices never appear here — only what is on the router now.
 */
export function HotspotLiveStrip({ routerId }: { routerId: string }) {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [data, setData] = useState<LivePayload | null>(null);
  const [fail, setFail] = useState("");

  useEffect(() => {
    let disposed = false;
    const pull = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await api<LivePayload>(`/api/hotspot/live?routerId=${routerId}&_=${Date.now()}`);
        if (!disposed) { setData(res); setFail(""); }
      } catch (e) {
        if (!disposed) setFail((e as Error).message);
      }
    };
    pull();
    const timer = setInterval(pull, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [routerId]);

  const counts = data?.counts;
  const updated = data?.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString(ar ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div className="panel p-3.5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          <h2 className="text-[12.5px] font-extrabold text-white" dir="auto">
            {ar ? "Hotspot الآن — Active / Hosts / Bindings" : "Hotspot now — Active / Hosts / Bindings"}
          </h2>
          <span className="text-[10px] text-[#64748B]" dir="ltr">{updated}</span>
        </div>
        <span className="text-[10px] text-[#64748B]" dir="auto">
          {ar ? "قراءة مباشرة من الراوتر كل 3 ثوانٍ" : "Read straight from the router every 3s"}
        </span>
      </div>

      {fail && (
        <div className="mb-3 text-[11px] text-red-400" dir="auto">{fail}</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3">
        <LiveTile icon={<Users className="w-4 h-4" />} label={ar ? "Active الآن" : "Active now"} value={counts?.active ?? 0} className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300" />
        <LiveTile icon={<MonitorSmartphone className="w-4 h-4" />} label={ar ? "Hosts مستضافة" : "Hosts"} value={counts?.hosts ?? 0} className="border-sky-500/30 bg-sky-500/10 text-sky-300" />
        <LiveTile icon={<Link2 className="w-4 h-4" />} label={ar ? "Bindings متصلة" : "Bindings connected"} value={counts?.connectedBindings ?? 0} className="border-violet-500/30 bg-violet-500/10 text-violet-300" />
        <LiveTile icon={<Activity className="w-4 h-4" />} label={ar ? "إجمالي Bindings" : "Total bindings"} value={counts?.bindings ?? 0} className="border-[#24344F] bg-[#111C30] text-[#8CA3C3]" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[#8CA3C3]">
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">{ar ? "المستخدم" : "User"}</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">IP</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">MAC</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">{ar ? "المدة" : "Uptime"}</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">{ar ? "المرسل" : "Up"}</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">{ar ? "المستقبل" : "Down"}</th>
              <th className="text-start px-2 py-1.5 font-bold text-[10px]">{ar ? "السيرفر" : "Router"}</th>
            </tr>
          </thead>
          <tbody className="text-[#E2E8F0]">
            {!data && (
              <tr><td colSpan={7} className="text-center py-5 text-[#64748B]">{ar ? "جارٍ القراءة من الراوتر…" : "Reading from the router…"}</td></tr>
            )}
            {data && data.active.length === 0 && (
              <tr><td colSpan={7} className="text-center py-5 text-[#64748B]" dir="auto">{ar ? "لا يوجد مستخدم متصل الآن" : "Nobody is connected right now"}</td></tr>
            )}
            {data?.active.slice(0, 6).map((r) => (
              <tr key={r.id} className="border-t border-[#1B2946]/60">
                <td className="px-2 py-1.5 font-bold text-[#67E8F9]" dir="auto">{r.user}</td>
                <td className="px-2 py-1.5 num" dir="ltr">{r.address ?? "—"}</td>
                <td className="px-2 py-1.5 num" dir="ltr">{r.mac ?? "—"}</td>
                <td className="px-2 py-1.5 num" dir="ltr">{r.uptime ?? "—"}</td>
                <td className="px-2 py-1.5 num" dir="ltr">{r.bytesIn.toFixed(2)} MB</td>
                <td className="px-2 py-1.5 num" dir="ltr">{r.bytesOut.toFixed(2)} MB</td>
                <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1"><Router className="w-3 h-3 text-[#64748B]" />{r.routerName}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.active.length > 6 && (
        <div className="mt-2 text-[10px] text-[#64748B]" dir="auto">
          {ar ? `+${fmtNum(data.active.length - 6)} جلسة أخرى — تابعها من صفحة الأجهزة` : `+${fmtNum(data.active.length - 6)} more — see the Devices page`}
        </div>
      )}
    </div>
  );
}

function LiveTile({ icon, label, value, className }: { icon: React.ReactNode; label: string; value: number; className: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2 flex items-center gap-2.5 ${className}`}>
      <div className="shrink-0 opacity-90">{icon}</div>
      <div className="min-w-0">
        <div className="text-[18px] leading-5 font-extrabold num" dir="ltr">{fmtNum(value)}</div>
        <div className="text-[9.5px] font-bold opacity-80 truncate" dir="auto">{label}</div>
      </div>
    </div>
  );
}
