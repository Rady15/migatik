"use client";

import { useEffect, useState, useCallback } from "react";
import { api, useApp, fmtNum, fmtMoney } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import { RouterSelect } from "@/components/ui/router-select";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, AreaChart, Area } from "recharts";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReportData {
  daily: { date: string; revenue: number; users: number }[];
  pkgPopularity: { name: string; count: number }[];
  paymentMethods: { method: string; count: number; total: number }[];
  totals: { revenue60d: number; expenses60d: number; vouchersSold60d: number; vouchersRevenue60d: number };
}

export function ReportsView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [data, setData] = useState<ReportData | null>(null);
  const [routerId, setRouterId] = useState("all");

  const load = useCallback(() => {
    api<ReportData>(`/api/reports?routerId=${routerId}`).then(setData).catch(() => {});
  }, [routerId]);

  useEffect(() => { load(); }, [load]);

  if (!data) return <Skeleton className="h-96 rounded-xl bg-[#111C33]" />;

  const methodLabels: Record<string, string> = { cash: "نقدي", bank: "تحويل بنكي", electronic: "إلكتروني", manual: "يدوي" };
  const methodColors: Record<string, string> = { cash: "#10B981", bank: "#1685FF", electronic: "#22D3EE", manual: "#F59E0B" };

  function exportCsv() {
    const rows = [["date", "revenue", "newUsers"], ...data!.daily.map((d) => [d.date, String(d.revenue), String(d.users)])];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "revenue-report.csv";
    a.click();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{t("reports")}</h1>
        <div className="flex items-center gap-2">
          <RouterSelect value={routerId} onChange={setRouterId} className="w-52" />
          <Button onClick={exportCsv} variant="ghost" className="text-[#CBD5E1] hover:bg-[#17243B] text-xs gap-1.5">
            <FileDown className="w-3.5 h-3.5" /> {t("exportCsv")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Tile label={lang === "ar" ? "إيرادات 60 يوم" : "Revenue 60d"} value={fmtMoney(data.totals.revenue60d)} color="text-emerald-300" />
        <Tile label={lang === "ar" ? "مصروفات 60 يوم" : "Expenses 60d"} value={fmtMoney(data.totals.expenses60d)} color="text-red-300" />
        <Tile label={lang === "ar" ? "كروت مباعة" : "Cards sold"} value={fmtNum(data.totals.vouchersSold60d)} color="text-blue-300" />
        <Tile label={lang === "ar" ? "إيراد الكروت" : "Cards revenue"} value={fmtMoney(data.totals.vouchersRevenue60d)} color="text-amber-300" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        <div className="panel p-4" dir="ltr">
          <div className="text-center panel-title text-white mb-2" dir="rtl">{t("revenueTrend")} — 30d</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10B981" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(96,128,180,0.12)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={30} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={{ background: "#0D1729", border: "1px solid #24344F", borderRadius: 10, fontSize: 11, color: "#F1F5F9" }} />
                <Area type="monotone" dataKey="revenue" stroke="#10B981" strokeWidth={2} fill="url(#revGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel p-4" dir="ltr">
          <div className="text-center panel-title text-white mb-2" dir="rtl">{t("pkgPopularity")}</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.pkgPopularity} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(96,128,180,0.12)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={{ background: "#0D1729", border: "1px solid #24344F", borderRadius: 10, fontSize: 11, color: "#F1F5F9" }} cursor={{ fill: "rgba(22,133,255,0.08)" }} />
                <Bar dataKey="count" fill="#1685FF" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel p-4">
          <div className="text-center panel-title text-white mb-2">{t("paymentMethods")}</div>
          <div className="h-56 relative" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.paymentMethods} dataKey="count" nameKey="method" innerRadius="55%" outerRadius="85%" stroke="none" paddingAngle={2}>
                  {data.paymentMethods.map((m) => (
                    <Cell key={m.method} fill={methodColors[m.method] ?? "#8CA3C3"} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#0D1729", border: "1px solid #24344F", borderRadius: 10, fontSize: 11, color: "#F1F5F9", direction: "rtl" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap justify-center gap-3 mt-1">
            {data.paymentMethods.map((m) => (
              <span key={m.method} className="flex items-center gap-1.5 text-[11px] text-[#CBD5E1] font-bold">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: methodColors[m.method] ?? "#8CA3C3" }} />
                {methodLabels[m.method] ?? m.method} — <span className="num" dir="ltr">{fmtMoney(m.total)}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="panel p-4" dir="ltr">
          <div className="text-center panel-title text-white mb-2" dir="rtl">{lang === "ar" ? "مشتركون جدد يومياً — 30 يوم" : "New subscribers daily — 30d"}</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="usrGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1685FF" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#1685FF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(96,128,180,0.12)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={30} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fill: "#8CA3C3", fontSize: 9 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={{ background: "#0D1729", border: "1px solid #24344F", borderRadius: 10, fontSize: 11, color: "#F1F5F9" }} />
                <Area type="monotone" dataKey="users" stroke="#1685FF" strokeWidth={2} fill="url(#usrGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="panel p-3">
      <div className="text-[11px] text-[#8CA3C3] font-bold">{label}</div>
      <div className={`text-base font-extrabold num mt-0.5 ${color}`} dir="ltr">{value}</div>
    </div>
  );
}
