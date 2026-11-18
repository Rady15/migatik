"use client";

import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { fmtNum } from "@/lib/store";
import { CreditCard, Users, Router, Wifi, TrendingUp, CircleCheck } from "lucide-react";
import type { DashboardData } from "./dashboard-view";

export function KpiCards({ kpis }: { kpis: DashboardData["kpis"] }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  // RTL DOM order = rightmost first, matching the design row (right→left):
  // معدل الاتصال (orange) · عدد السيرفرات (blue) · المستخدمين (green) · المدفوعات (purple)
  const cards = [
    {
      key: "rate",
      value: `${kpis.connectionRate.toFixed(1)}%`,
      label: t("connectionRate"),
      trend: null,
      icon: <Wifi className="w-6 h-6 text-white" />,
      bg: "from-[#C9680C] to-[#8A4A0B]",
      check: false,
    },
    {
      key: "servers",
      value: fmtNum(kpis.serversCount),
      label: t("serversCount"),
      trend: null,
      icon: <Router className="w-6 h-6 text-white" />,
      bg: "from-[#1D5FD6] to-[#123C8F]",
      check: true,
    },
    {
      key: "users",
      value: fmtNum(kpis.usersTotal),
      label: t("totalUsers"),
      trend: kpis.usersGrowth,
      icon: <Users className="w-6 h-6 text-white" />,
      bg: "from-[#0A8F62] to-[#076442]",
      check: false,
    },
    {
      key: "payments",
      value: `$ ${fmtNum(kpis.totalPayments)}`,
      label: t("totalPayments"),
      trend: kpis.paymentsGrowth,
      icon: <CreditCard className="w-6 h-6 text-white" />,
      bg: "from-[#4A33A6] to-[#2E2168]",
      check: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
      {cards.map((c) => (
        <div
          key={c.key}
          className={`relative rounded-xl bg-gradient-to-bl ${c.bg} p-4 min-h-[106px] overflow-hidden`}
        >
          {/* icon tile — physically top-left, matching the design */}
          <div className="absolute top-3.5 end-3.5 w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center backdrop-blur-sm">
            {c.icon}
          </div>
          <div className="flex flex-col h-full min-h-[74px]">
            <div className="text-white font-extrabold text-[22px] num whitespace-nowrap text-right" dir="ltr">{c.value}</div>
            <div className="text-white/85 text-[12px] font-bold flex items-center gap-1 mt-0.5 text-right">
              <span className="truncate">{c.label}</span>
              {c.check && <CircleCheck className="w-3.5 h-3.5 text-emerald-300 shrink-0" />}
            </div>
            {c.trend !== null && (
              <div className="mt-auto pt-1.5 flex justify-end">
                <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-emerald-300 bg-black/20 rounded-md px-1.5 py-0.5 num">
                  <TrendingUp className="w-3 h-3" />
                  {Math.abs(c.trend).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
