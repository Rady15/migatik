"use client";

import { useApp, fmtNum, fmtMoney } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Users, CreditCard, CircleDollarSign } from "lucide-react";
import type { DashboardData } from "./dashboard-view";

export function QuickStats({ stats }: { stats: DashboardData["quickStats"] }) {
  const setView = useApp((s) => s.setView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  const tiles = [
    {
      value: fmtMoney(stats.revenue),
      label: t("totalRevenue"),
      icon: <CircleDollarSign className="w-5 h-5 text-white" />,
      bg: "from-[#C9680C] to-[#8A4A0B]",
    },
    {
      value: fmtNum(stats.cards),
      label: t("attachedCards"),
      icon: <CreditCard className="w-5 h-5 text-white" />,
      bg: "from-[#0A8F62] to-[#076442]",
    },
    {
      value: fmtNum(stats.activeUsers),
      label: t("activeUsers"),
      icon: <Users className="w-5 h-5 text-white" />,
      bg: "from-[#1D5FD6] to-[#123C8F]",
    },
  ];

  return (
    <div className="panel p-4 h-full flex flex-col">
      <div className="panel-title text-white mb-3">{t("quickStats")}</div>
      <div className="grid grid-cols-3 gap-2.5 flex-1">
        {tiles.map((tl) => (
          <div key={tl.label} className={`rounded-xl bg-gradient-to-b ${tl.bg} p-3 flex flex-col items-center justify-center gap-1.5 min-h-[104px]`}>
            {tl.icon}
            <div className="text-white font-extrabold text-[15px] num whitespace-nowrap" dir="ltr">{tl.value}</div>
            <div className="text-white/80 text-[10.5px] font-bold text-center leading-tight">{tl.label}</div>
          </div>
        ))}
      </div>
      <button
        onClick={() => setView("reports")}
        className="mt-3 w-full bg-gradient-to-l from-[#5B3FD6] to-[#3B2A8C] hover:from-[#6C50E6] hover:to-[#4936A6] text-white text-[12.5px] font-bold rounded-lg py-2.5 transition-all shadow-lg shadow-indigo-900/30"
      >
        {t("revenueReport")}
      </button>
    </div>
  );
}
