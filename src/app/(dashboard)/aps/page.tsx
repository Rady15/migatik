"use client";

import { useEffect, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "next/navigation";
import { Search, RefreshCw, Loader2, Wifi, Signal, Activity, Users, Download, Upload, TrendingUp, ExternalLink } from "lucide-react";

interface APListItem {
  name: string;
  routerId: string;
  routerName: string | null;
  routerHost: string | null;
  routerStatus: string | null;
  clientCount: number;
  totalDownloadMb: number;
  totalUploadMb: number;
  totalConsumptionGb: number;
  manufacturer: string | null;
  connectionType: string | null;
  trafficDays: number;
}

export default function APsPage() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [aps, setAps] = useState<APListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedRouter, setSelectedRouter] = useState<string>("all");
  const [periodDays, setPeriodDays] = useState(7);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period: String(periodDays) });
      if (selectedRouter !== "all") params.set("routerId", selectedRouter);
      const d = await api<{ aps: APListItem[] }>(`/api/aps?${params.toString()}`);
      setAps(d.aps);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [selectedRouter, periodDays]);

  const routers = useState(() => {
    const r = new Map<string, { id: string; name: string; host: string }>();
    aps.forEach((ap) => {
      if (ap.routerId && !r.has(ap.routerId)) r.set(ap.routerId, { id: ap.routerId, name: ap.routerName!, host: ap.routerHost! });
    });
    return [...r.values()];
  })[0];

  const filteredAps = aps.filter((ap) =>
    !search || ap.name.toLowerCase().includes(search.toLowerCase()) ||
    (ap.routerName?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  const fmtMb = (mb: number) => {
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(2)} MB`;
  };

  const statusColor = (status: string | null) => {
    if (!status) return "#64748B";
    switch (status) {
      case "online": return "#10B981";
      case "offline": return "#EF4444";
      case "untested": return "#F59E0B";
      default: return "#64748B";
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[16px] font-extrabold text-white flex items-center gap-2">
          <Wifi className="w-5 h-5 text-[#22D3EE]" />
          {lang === "ar" ? "نقاط الوصول (Access Points)" : "Access Points"}
        </h1>
        <Select value={selectedRouter} onValueChange={setSelectedRouter} className="w-56">
          <SelectTrigger className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]">
            <SelectValue placeholder={lang === "ar" ? "كل الراوترات" : "All Routers"} />
          </SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946]">
            <SelectItem key="all" value="all" className="text-[12px]" dir="ltr">{lang === "ar" ? "كل الراوترات" : "All Routers"}</SelectItem>
            {routers.map((r) => (
              <SelectItem key={r.id} value={r.id} className="text-[12px]" dir="ltr">{r.name} ({r.host})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(periodDays)} onValueChange={(v) => setPeriodDays(parseInt(v))} className="w-40">
          <SelectTrigger className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]">
            <SelectValue placeholder="Period" />
          </SelectTrigger>
          <SelectContent className="bg-[#111C30] border-[#1B2946]">
            <SelectItem key="1" value="1" className="text-[12px]" dir="ltr">1 Day</SelectItem>
            <SelectItem key="7" value="7" className="text-[12px]" dir="ltr">7 Days</SelectItem>
            <SelectItem key="30" value="30" className="text-[12px]" dir="ltr">30 Days</SelectItem>
            <SelectItem key="90" value="90" className="text-[12px]" dir="ltr">90 Days</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative min-w-[180px] flex-1 max-w-[300px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={lang === "ar" ? "ابحث عن AP..." : "Search AP..."} className="h-8 ps-8 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>
        <Button size="sm" className="h-8 text-[11px]" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 me-1" />}{lang === "ar" ? "تحديث" : "Refresh"}
        </Button>
      </div>

      {toast && (
        <div className={`p-2 rounded bg-${toast.ok ? "emerald-950/30 border-emerald-700/50" : "red-950/30 border-red-800/50"} border text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">
          {toast.msg}
        </div>
      )}

      {/* AP Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filteredAps.length === 0 ? (
          <div className="col-span-full text-center py-12 text-[#64748B]">
            {search ? (lang === "ar" ? "لا توجد نتائج للبحث" : "No APs found") : (lang === "ar" ? "لا توجد نقاط وصول مكتشفة" : "No APs discovered")}
          </div>
        ) : (
          filteredAps.map((ap) => (
            <Link key={`${ap.routerId}-${ap.name}`} href={`/aps/${encodeURIComponent(ap.name)}?routerId=${ap.routerId}&period=${periodDays}`}>
              <div className="panel p-4 hover:bg-[#14213A] transition-colors cursor-pointer border-l-4" style={{ borderLeftColor: ap.routerStatus === "online" ? "#10B981" : "#EF4444" }}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[13px] font-bold text-white truncate" dir="ltr">{ap.name}</h3>
                    <p className="text-[10px] text-[#64748B] truncate" dir="ltr">{ap.routerName} ({ap.routerHost})</p>
                  </div>
                  <span className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ background: statusColor(ap.routerStatus) }} />
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="text-center p-2 bg-[#0A1020] rounded">
                    <p className="text-[18px] font-bold text-[#22D3EE] num" dir="ltr">{ap.clientCount}</p>
                    <p className="text-[9px] text-[#64748B]">{lang === "ar" ? "أجهزة متصلة" : "Connected"}</p>
                  </div>
                  <div className="text-center p-2 bg-[#0A1020] rounded">
                    <p className="text-[18px] font-bold text-[#10B981] num" dir="ltr">{fmtMb(ap.totalConsumptionGb * 1024)}</p>
                    <p className="text-[9px] text-[#64748B]">{lang === "ar" ? "استهلاك" : "Consumption"}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[9px]">
                  <Badge variant="outline" className="h-5 text-[9px] border-[#1B2946]">{ap.manufacturer ?? (lang === "ar" ? "غير معروف" : "Unknown")}</Badge>
                  <Badge variant="outline" className="h-5 text-[9px] border-[#1B2946]">{ap.connectionType ?? (lang === "ar" ? "غير معروف" : "Unknown")}</Badge>
                  <Badge variant="outline" className="h-5 text-[9px] border-[#1B2946]">{ap.trafficDays} {lang === "ar" ? "يوم بيانات" : "days data"}</Badge>
                </div>

                <div className="mt-3 pt-3 border-t border-[#1B2946] flex items-center justify-between">
                  <div className="flex items-center gap-4 text-[10px] text-[#64748B]">
                    <span className="flex items-center gap-1"><Download className="w-3 h-3" />{fmtMb(ap.totalDownloadMb)}</span>
                    <span className="flex items-center gap-1"><Upload className="w-3 h-3" />{fmtMb(ap.totalUploadMb)}</span>
                  </div>
                  <span className="text-[10px] text-[#4C5F80] flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" />{lang === "ar" ? "تفاصيل" : "Details"}
                  </span>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}