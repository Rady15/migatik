"use client";

import { useEffect, useState } from "react";
import { useApp, type ViewKey, api } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import {
  Home, Server, Users, Package, Activity, BarChart3, CreditCard, IdCard,
  Settings, Wrench, LifeBuoy, ShieldCheck, Database, CircleCheck, Boxes, Network,
  ContactRound, Wallet, Building2, SlidersHorizontal, RadioTower,
} from "lucide-react";

interface RouterRow {
  id: string;
  name: string;
  host: string;
  status: string;
}

export function Sidebar({ activeView, onNavigate }: { activeView: ViewKey; onNavigate?: () => void }) {
  const setView = useApp((s) => s.setView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [routers, setRouters] = useState<RouterRow[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ routers: RouterRow[] }>("/api/routers")
        .then((d) => alive && setRouters(d.routers))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const items: { key: ViewKey; label: string; icon: React.ReactNode }[] = [
    { key: "dashboard", label: t("home"), icon: <Home className="w-4 h-4" /> },
    { key: "devices", label: t("devices"), icon: <Boxes className="w-4 h-4" /> },
    { key: "topology", label: t("networkMap"), icon: <Network className="w-4 h-4" /> },
    { key: "consumption", label: lang === "ar" ? "الاستهلاك" : "Consumption", icon: <Activity className="w-4 h-4" /> },
    { key: "servers", label: t("servers"), icon: <Server className="w-4 h-4" /> },
    { key: "agents", label: lang === "ar" ? "وكلاء الشبكة" : "Network Agents", icon: <RadioTower className="w-4 h-4" /> },
    { key: "users", label: t("users"), icon: <Users className="w-4 h-4" /> },
    { key: "subscribers", label: lang === "ar" ? "المشتركون" : "Subscribers", icon: <ContactRound className="w-4 h-4" /> },
    { key: "packages", label: t("packages"), icon: <Package className="w-4 h-4" /> },
    { key: "monitoring", label: t("monitoring"), icon: <Activity className="w-4 h-4" /> },
    { key: "reports", label: t("reports"), icon: <BarChart3 className="w-4 h-4" /> },
    { key: "payments", label: t("payments"), icon: <CreditCard className="w-4 h-4" /> },
    { key: "finance", label: lang === "ar" ? "المالية" : "Finance", icon: <Wallet className="w-4 h-4" /> },
    { key: "cards", label: t("cards"), icon: <IdCard className="w-4 h-4" /> },
    { key: "branches", label: lang === "ar" ? "الفروع" : "Branches", icon: <Building2 className="w-4 h-4" /> },
    { key: "ros", label: lang === "ar" ? "إدارة راوترOS" : "RouterOS Manager", icon: <SlidersHorizontal className="w-4 h-4" /> },
    { key: "settings", label: t("settings"), icon: <Settings className="w-4 h-4" /> },
    { key: "tools", label: t("tools"), icon: <Wrench className="w-4 h-4" /> },
    { key: "support", label: t("support"), icon: <LifeBuoy className="w-4 h-4" /> },
  ];

  const onlineCount = routers.filter((r) => r.status === "online").length;

  return (
    <div className="flex flex-col h-full">
      {/* logo */}
      <div className="px-4 pt-5 pb-4 shrink-0" onClick={() => { setView("dashboard"); onNavigate?.(); }} role="button" tabIndex={0}>
        <div className="text-white font-extrabold text-[26px] leading-none tracking-tight" dir="ltr">MikroTik</div>
        <div className="text-[#7E93B4] text-[10.5px] mt-0.5" dir="ltr">Management System</div>
        <svg viewBox="0 0 140 14" className="w-28 h-3 mt-1.5" aria-hidden="true">
          <path d="M2 10 C 25 2, 45 2, 68 8 S 115 13, 138 5" fill="none" stroke="#22D3EE" strokeWidth="2.2" strokeLinecap="round" opacity="0.9" />
          <path d="M2 12 C 28 6, 50 5, 72 10 S 118 14, 138 8" fill="none" stroke="#1685FF" strokeWidth="1.4" strokeLinecap="round" opacity="0.5" />
        </svg>
      </div>

      {/* menu */}
      <nav className="flex-1 overflow-y-auto px-2.5 space-y-1" aria-label="main navigation">
        {items.map((it) => {
          const active = activeView === it.key;
          return (
            <button
              key={it.key}
              onClick={() => { setView(it.key); onNavigate?.(); }}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[12.5px] font-semibold transition-all duration-200 ${
                active
                  ? "bg-gradient-to-l from-[#2E82FF] to-[#0F55C4] text-white shadow-lg shadow-[#1685FF]/25"
                  : "text-[#94A9C9] hover:bg-[#141F38] hover:text-[#D9E4F5]"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span className={active ? "text-white" : "text-[#5B7194]"}>{it.icon}</span>
              <span className="truncate">{it.label}</span>
            </button>
          );
        })}
      </nav>

      {/* servers status widget */}
      <div className="p-3 shrink-0">
        <div className="panel p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
              <CircleCheck className="w-3 h-3 text-white" />
            </span>
            <span className="text-[12px] font-bold text-white">{t("serversStatus")}</span>
          </div>
          <div className="flex items-center gap-1.5 mb-2.5">
            <Database className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] font-bold text-emerald-400">
              {onlineCount}/{routers.length} {t("connected")}
            </span>
          </div>
          <div className="space-y-2">
            {routers.length === 0 && <div className="text-[10px] text-[#64748B]">{lang === "ar" ? "لا توجد سيرفرات" : "No servers"}</div>}
            {routers.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-1 cursor-pointer" onClick={() => { setView("servers"); onNavigate?.(); }}>
                <div className="min-w-0">
                  <div className="text-[11px] font-bold truncate text-[#E2E8F0]" dir="ltr">{r.name}</div>
                  <div className="text-[9.5px] text-[#64748B] num" dir="ltr">{r.host}</div>
                </div>
                <span
                  className={`dot ${r.status === "online" ? "dot-green" : r.status === "offline" ? "dot-red" : "dot-gray"}`}
                  title={r.status}
                />
              </div>
            ))}
          </div>
          {/* decorative wave */}
          <svg viewBox="0 0 160 28" className="w-full h-7 mt-2.5" aria-hidden="true">
            <path d="M0 22 C 20 12, 35 24, 55 16 S 95 6, 118 14 S 145 20, 160 12" fill="none" stroke="#1685FF" strokeWidth="1.6" opacity="0.75" />
            <path d="M0 26 C 22 18, 40 26, 62 20 S 100 12, 124 18 S 148 24, 160 18" fill="none" stroke="#22D3EE" strokeWidth="1.1" opacity="0.45" />
          </svg>
        </div>
        <div className="flex items-center justify-center gap-1 mt-2 text-[9px] text-[#4C5F80]">
          <ShieldCheck className="w-3 h-3" />
          <span>Secured Connection</span>
        </div>
      </div>
    </div>
  );
}
