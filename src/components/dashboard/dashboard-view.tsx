"use client";

import { useEffect, useState, useCallback } from "react";
import { api, useApp } from "@/lib/store";
import { RouterSelect } from "@/components/ui/router-select";
import { KpiCards } from "./kpi-cards";
import { HotspotLiveStrip } from "./hotspot-live-strip";
import { NetworkChart } from "./network-chart";
import { StatusDonut } from "./status-donut";
import { WorldMap } from "./world-map";
import { RecentUsers } from "./recent-users";
import { QuickStats } from "./quick-stats";
import { ActionCards } from "./action-cards";
import { Skeleton } from "@/components/ui/skeleton";

export interface DashboardData {
  kpis: {
    totalPayments: number;
    paymentsGrowth: number;
    usersTotal: number;
    usersGrowth: number;
    serversCount: number;
    serversOnline: number;
    connectionRate: number;
    todayRevenue: number;
    activeSessions: number;
    unreadNotifications: number;
  };
  userStatus: { online: number; suspended: number; expired: number };
  network: { time: string; download: number; upload: number; users: number }[];
  recentUsers: { id: string; username: string; speed: string; status: string; durationSec: number; startedAt: string }[];
  quickStats: { activeUsers: number; cards: number; revenue: number };
  servers: { id: string; name: string; host: string; status: string }[];
  mapUsers: Record<string, number>;
}

export function DashboardView() {
  const lang = useApp((s) => s.lang);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [routerId, setRouterId] = useState("all");

  const load = useCallback(() => {
    api<DashboardData>(`/api/dashboard?routerId=${routerId}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError((e as Error).message));
  }, [routerId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !data) {
    return (
      <div className="space-y-3.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-lg font-extrabold text-white">{lang === "ar" ? "لوحة التحكم" : "Dashboard"}</h1>
          <RouterSelect value={routerId} onChange={setRouterId} className="w-56" />
        </div>
        <div className="panel p-6 text-center">
          <div className="text-[#FCA5A5] font-bold text-sm mb-1">{error}</div>
          <button onClick={load} className="text-[#1685FF] text-xs underline">إعادة المحاولة</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-lg font-extrabold text-white">{lang === "ar" ? "لوحة التحكم" : "Dashboard"}</h1>
          <RouterSelect value={routerId} onChange={setRouterId} className="w-56" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-[110px] rounded-xl bg-[#111C33]" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Skeleton className="lg:col-span-5 h-[250px] rounded-xl bg-[#111C33]" />
          <Skeleton className="lg:col-span-3 h-[250px] rounded-xl bg-[#111C33]" />
          <Skeleton className="lg:col-span-4 h-[250px] rounded-xl bg-[#111C33]" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Skeleton className="lg:col-span-8 h-[250px] rounded-xl bg-[#111C33]" />
          <Skeleton className="lg:col-span-4 h-[250px] rounded-xl bg-[#111C33]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white">{lang === "ar" ? "لوحة التحكم" : "Dashboard"}</h1>
        <RouterSelect value={routerId} onChange={setRouterId} className="w-56" />
      </div>
      <KpiCards kpis={data.kpis} />
      <HotspotLiveStrip routerId={routerId} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        <div className="lg:col-span-4">
          <WorldMap mapUsers={data.mapUsers} />
        </div>
        <div className="lg:col-span-3">
          <StatusDonut status={data.userStatus} total={data.kpis.usersTotal} />
        </div>
        <div className="lg:col-span-5">
          <NetworkChart data={data.network} />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        <div className="lg:col-span-4">
          <QuickStats stats={data.quickStats} />
        </div>
        <div className="lg:col-span-8">
          <RecentUsers users={data.recentUsers} />
        </div>
      </div>
      <ActionCards />
    </div>
  );
}
