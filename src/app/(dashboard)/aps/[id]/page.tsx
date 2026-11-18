"use client";

import { useEffect, useState } from "react";
import { api, fmtNum, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, useParams, useSearchParams, useRouter } from "next/navigation";
import { Search, RefreshCw, Loader2, Wifi, Signal, Activity, Users, Download, Upload, TrendingUp, ExternalLink, BarChart3, AlertTriangle, Calendar, Clock } from "lucide-react";

interface APDetail {
  ap: { name: string; routerId: string; routerName: string | null; routerHost: string | null; routerStatus: string | null };
  clients: any[];
  traffic: { day: string; downMb: number; upMb: number }[];
  totals: { totalDownloadMb: number; totalUploadMb: number; totalConsumptionGb: number; clientCount: number; onlineClients: number; idleClients: number; offlineClients: number };
  charts: { trafficDays: number; statusDistribution: Record<string, number>; connectionTypeDistribution: Record<string, number>; topManufacturers: [string, number][] };
}

export default function APDetailPage() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const routerId = searchParams.get("routerId") ?? "";
  const periodDays = parseInt(searchParams.get("period") ?? "30", 10);
  const apName = decodeURIComponent(params.id as string);

  const [data, setData] = useState<APDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  const load = async () => {
    if (!routerId) return;
    setLoading(true);
    try {
      const d = await api<APDetail>(`/api/aps/${encodeURIComponent(apName)}?routerId=${routerId}&period=${periodDays}`);
      setData(d);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [routerId, periodDays, apName]);

  const fmtMb = (mb: number) => {
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(2)} MB`;
  };

  const statusColor = (status: string | undefined) => {
    switch (status) {
      case "online": return "#10B981";
      case "offline": return "#EF4444";
      case "idle": return "#38BDF8";
      case "blocked": return "#F97316";
      case "recently_disconnected": return "#FBBF24";
      default: return "#64748B";
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-[#1685FF]" /></div>;

  if (!data) return <div className="text-center py-8 text-[#64748B]">{lang === "ar" ? "فشل تحميل بيانات AP" : "Failed to load AP data"}</div>;

  const { ap, clients, traffic, totals, charts } = data;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/aps?routerId=${routerId}&period=${periodDays}`} className="text-[#64748B] hover:text-white">
            <ExternalLink className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-[16px] font-extrabold text-white flex items-center gap-2">
              <Wifi className="w-5 h-5 text-[#22D3EE]" />
              {ap.name}
            </h1>
            <p className="text-[11px] text-[#64748B] flex items-center gap-1" dir="ltr">
              <span className="w-2 h-2 rounded-full" style={{ background: ap.routerStatus === "online" ? "#10B981" : "#EF4444" }} />
              {ap.routerName} ({ap.routerHost}) — {ap.routerStatus}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(periodDays)} onValueChange={(v) => {
            const next = new URLSearchParams(searchParams.toString());
            next.set("period", v);
            router.replace(`?${next.toString()}`, { scroll: false });
          }} className="w-40">
            <SelectTrigger className="h-8 text-[12px] bg-[#111C30] border-[#1B2946]">
              <SelectValue placeholder="Period" />
            </SelectTrigger>
            <SelectContent className="bg-[#111C30] border-[#1B2946]">
              <SelectItem key="7" value="7" className="text-[12px]" dir="ltr">7 Days</SelectItem>
              <SelectItem key="30" value="30" className="text-[12px]" dir="ltr">30 Days</SelectItem>
              <SelectItem key="90" value="90" className="text-[12px]" dir="ltr">90 Days</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-[11px]" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 me-1" />}{lang === "ar" ? "تحديث" : "Refresh"}
          </Button>
        </div>
      </div>

      {toast && (
        <div className={`p-2 rounded bg-${toast.ok ? "emerald-950/30 border-emerald-700/50" : "red-950/30 border-red-800/50"} border text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">
          {toast.msg}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-[#101B31] border-[#1B2946]">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "إجمالي الأجهزة" : "Total Clients"}</p>
                <p className="text-[20px] font-bold text-white num" dir="ltr">{totals.clientCount}</p>
              </div>
              <Users className="w-6 h-6 text-[#22D3EE]" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#101B31] border-[#1B2946]">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "متصل الآن" : "Online Now"}</p>
                <p className="text-[20px] font-bold text-[#10B981] num" dir="ltr">{totals.onlineClients}</p>
              </div>
              <Signal className="w-6 h-6 text-[#10B981]" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#101B31] border-[#1B2946]">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "تنزيل" : "Download"}</p>
                <p className="text-[20px] font-bold text-[#22D3EE] num" dir="ltr">{fmtMb(totals.totalDownloadMb)}</p>
              </div>
              <Download className="w-6 h-6 text-[#22D3EE]" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#101B31] border-[#1B2946]">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "إجمالي الاستهلاك" : "Total Consumption"}</p>
                <p className="text-[20px] font-bold text-[#F59E0B] num" dir="ltr">{totals.totalConsumptionGb.toFixed(2)} GB</p>
              </div>
              <TrendingUp className="w-6 h-6 text-[#F59E0B]" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-[#101B31] border border-[#1B2946]">
          <TabsTrigger value="overview" className="text-[12px]">{lang === "ar" ? "نظرة عامة" : "Overview"}</TabsTrigger>
          <TabsTrigger value="clients" className="text-[12px]">{lang === "ar" ? "الأجهزة المتصلة" : "Connected Clients"}</TabsTrigger>
          <TabsTrigger value="traffic" className="text-[12px]">{lang === "ar" ? "الحركة والاستهلاك" : "Traffic"} </TabsTrigger>
          <TabsTrigger value="charts" className="text-[12px]">{lang === "ar" ? "الرسوم البيانية" : "Charts"}</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card className="bg-[#101B31] border-[#1B2946]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12px] flex items-center gap-2"><Activity className="w-4 h-4" />{lang === "ar" ? "حالة الأجهزة" : "Device Status"}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(charts.statusDistribution).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: statusColor(status) }} />
                        <span className="capitalize">{status}</span>
                      </span>
                      <span className="font-bold text-white num" dir="ltr">{count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-[#101B31] border-[#1B2946]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12px] flex items-center gap-2"><Wifi className="w-4 h-4" />{lang === "ar" ? "نوع الاتصال" : "Connection Type"}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(charts.connectionTypeDistribution).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between text-[12px]">
                      <span className="capitalize">{type}</span>
                      <span className="font-bold text-white num" dir="ltr">{count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="bg-[#101B31] border-[#1B2946]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[12px] flex items-center gap-2"><TrendingUp className="w-4 h-4" />{lang === "ar" ? "إحصائيات الفترة ({periodDays} يوم)" : "Period Stats ({periodDays} days)"}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div>
                  <p className="text-[18px] font-bold text-[#22D3EE] num" dir="ltr">{charts.trafficDays} / {periodDays}</p>
                  <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "أيام مع بيانات" : "Days with Data"}</p>
                </div>
                <div>
                  <p className="text-[18px] font-bold text-[#22D3EE] num" dir="ltr">{fmtMb(data.totals.totalDownloadMb)}</p>
                  <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "إجمالي التنزيل" : "Total Download"}</p>
                </div>
                <div>
                  <p className="text-[18px] font-bold text-[#22D3EE] num" dir="ltr">{fmtMb(data.totals.totalUploadMb)}</p>
                  <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "إجمالي الرفع" : "Total Upload"}</p>
                </div>
                <div>
                  <p className="text-[18px] font-bold text-[#F59E0B] num" dir="ltr">{data.totals.totalConsumptionGb.toFixed(2)} GB</p>
                  <p className="text-[10px] text-[#64748B]">{lang === "ar" ? "إجمالي الاستهلاك" : "Total Consumption"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Clients */}
        <TabsContent value="clients" className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] text-[#64748B] border-b border-[#1B2946]">
                  <th className="pb-2 pr-3">{lang === "ar" ? "الاسم" : "Name"}</th>
                  <th className="pb-2 pr-3">{lang === "ar" ? "IP" : "IP"}</th>
                  <th className="pb-2 pr-3">{lang === "ar" ? "MAC" : "MAC"}</th>
                  <th className="pb-2 pr-3">{lang === "ar" ? "الحالة" : "Status"}</th>
                  <th className="pb-2 pr-3">{lang === "ار" ? "نوع الاتصال" : "Conn. Type"}</th>
                  <th className="pb-2 pr-3">{lang === "ار" ? "آخر ظهور" : "Last Seen"}</th>
                  <th className="pb-2 pr-3">{lang === "ار" ? "النشاط" : "Last Active"}</th>
                  <th className="pb-2 pr-3">{lang === "ار" ? "VLAN" : "VLAN"}</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8 text-[#64748B]">{lang === "ار" ? "لا توجد أجهزة متصلة" : "No connected clients"}</td></tr>
                ) : (
                  data.clients.map((c) => (
                    <tr key={c.id} className="border-b border-[#1B2946]/50 hover:bg-[#14213A]">
                      <td className="py-2 pr-3 text-[#CBD5E1] truncate max-w-[160px]" dir="ltr">{c.customName || c.hostname || c.macAddress}</td>
                      <td className="py-2 pr-3 text-[#8CA3C3] num" dir="ltr">{c.ipAddress ?? "—"}</td>
                      <td className="py-2 pr-3 text-[#8CA3C3] num font-mono text-[10px]" dir="ltr">{c.macAddress}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1 text-[10px]">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(c.status) }} />
                          <span className="capitalize">{c.status}</span>
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-[10px] text-[#8CA3C3] capitalize">{c.connectionType}</td>
                      <td className="py-2 pr-3 text-[9px] text-[#64748B] num" dir="ltr">{c.lastSeen ? new Date(c.lastSeen).toLocaleString() : "—"}</td>
                      <td className="py-2 pr-3 text-[9px] text-[#64748B] num" dir="ltr">{c.lastActive ? new Date(c.lastActive).toLocaleString() : "—"}</td>
                      <td className="py-2 pr-3 text-[9px] text-[#8B5CF6] num" dir="ltr">{c.vlanId ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Traffic */}
        <TabsContent value="traffic" className="space-y-4">
          <Card className="bg-[#101B31] border-[#1B2946]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[12px] flex items-center gap-2"><TrendingUp className="w-4 h-4" />{lang === "ar" ? "الحركة اليومية" : "Daily Traffic"}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] text-[#64748B] border-b border-[#1B2946]">
                      <th className="pb-2 pr-3">{lang === "ار" ? "اليوم" : "Day"}</th>
                      <th className="pb-2 pr-3">{lang === "ار" ? "تنزيل" : "Download"}</th>
                      <th className="pb-2 pr-3">{lang === "ار" ? "رفع" : "Upload"}</th>
                      <th className="pb-2 pr-3">{lang === "ار" ? "إجمالي" : "Total"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.traffic.length === 0 ? (
                      <tr><td colSpan={4} className="text-center py-8 text-[#64748B]">{lang === "ار" ? "لا توجد بيانات حركة" : "No traffic data"}</td></tr>
                    ) : (
                      data.traffic.map((t) => (
                        <tr key={t.day} className="border-b border-[#1B2946]/50">
                          <td className="py-2 pr-3 text-[10px] text-[#CBD5E1] num" dir="ltr">{new Date(t.day).toLocaleDateString()}</td>
                          <td className="py-2 pr-3 text-[10px] text-[#22D3EE] num" dir="ltr">{fmtMb(t.downMb)}</td>
                          <td className="py-2 pr-3 text-[10px] text-[#1685FF] num" dir="ltr">{fmtMb(t.upMb)}</td>
                          <td className="py-2 pr-3 text-[10px] text-[#F59E0B] num font-bold" dir="ltr">{fmtMb(t.downMb + t.upMb)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Charts */}
        <TabsContent value="charts" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card className="bg-[#101B31] border-[#1B2946]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12px] flex items-center gap-2"><BarChart3 className="w-4 h-4" />{lang === "ar" ? "أعلى الشركات المصنعة" : "Top Manufacturers"}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {charts.topManufacturers.map(([mfr, count]) => (
                    <div key={mfr} className="flex items-center justify-between text-[11px]">
                      <span className="truncate max-w-[200px]" dir="ltr">{mfr}</span>
                      <span className="font-bold text-white num" dir="ltr">{count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-[#101B31] border-[#1B2946]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[12px] flex items-center gap-2"><Calendar className="w-4 h-4" />{lang === "ar" ? "أيام البيانات" : "Data Days: {charts.trafficDays} / {periodDays}"}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center">
                  <p className="text-[28px] font-bold text-[#22D3EE] num" dir="ltr">{charts.trafficDays} / {periodDays}</p>
                  <p className="text-[10px] text-[#64748B] mt-1">{lang === "ار" ? "أيام بها بيانات حركة" : "Days with traffic data"}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}