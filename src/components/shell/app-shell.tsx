"use client";

import { useEffect, useState, useCallback } from "react";
import { useApp, type ViewKey } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { Footer } from "./footer";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { RoutersView } from "@/components/views/routers-view";
import { HotspotUsersView } from "@/components/views/hotspot-users-view";
import { PackagesView } from "@/components/views/packages-view";
import { MonitoringView } from "@/components/views/monitoring-view";
import { ReportsView } from "@/components/views/reports-view";
import { PaymentsView } from "@/components/views/payments-view";
import { VouchersView } from "@/components/views/vouchers-view";
import { ToolsView } from "@/components/views/tools-view";
import { SupportView } from "@/components/views/support-view";
import { SettingsView } from "@/components/views/settings-view";
import { DevicesView } from "@/components/views/devices-view";
import { TopologyView } from "@/components/views/topology-view";
import { ConsumptionView } from "@/components/views/consumption-view";
import { SubscribersView } from "@/components/views/subscribers-view";
import { FinanceView } from "@/components/views/finance-view";
import { BranchesView } from "@/components/views/branches-view";
import { RosManagerView } from "@/components/views/ros-manager-view";
import { AgentsView } from "@/components/views/agents-view";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";

export interface AppUser {
  id: string;
  name: string;
  role: string;
}

export function AppShell({ user, onLogout }: { user: AppUser; onLogout: () => void }) {
  const activeView = useApp((s) => s.activeView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const renderView = useCallback(() => {
    switch (activeView) {
      case "dashboard": return <DashboardView />;
      case "devices": return <DevicesView />;
      case "topology": return <TopologyView />;
      case "consumption": return <ConsumptionView />;
      case "servers": return <RoutersView />;
      case "agents": return <AgentsView />;
      case "users": return <HotspotUsersView />;
      case "packages": return <PackagesView />;
      case "monitoring": return <MonitoringView />;
      case "reports": return <ReportsView />;
      case "payments": return <PaymentsView />;
      case "cards": return <VouchersView />;
      case "tools": return <ToolsView />;
      case "support": return <SupportView />;
      case "settings": return <SettingsView user={user} />;
      case "subscribers": return <SubscribersView />;
      case "finance": return <FinanceView />;
      case "branches": return <BranchesView />;
      case "ros": return <RosManagerView />;
      default: return <DashboardView />;
    }
  }, [activeView, user]);

  return (
    <div className="min-h-screen bg-[#0A1020] text-[#F1F5F9] flex flex-col">
      {/* mobile top bar with hamburger */}
      <div className="lg:hidden sticky top-0 z-40 bg-[#0A1020]/95 backdrop-blur border-b border-[#1B2946] no-print">
        <div className="flex items-center justify-between px-3 h-12">
          <Button variant="ghost" size="icon" aria-label="menu" onClick={() => setMobileNavOpen(true)} className="text-[#CBD5E1]">
            <Menu className="w-5 h-5" />
          </Button>
          <div className="flex flex-col items-center leading-none">
            <span className="font-extrabold text-white text-base">MikroTik</span>
            <span className="text-[9px] text-[#64748B]">Management System</span>
          </div>
          <div className="w-9" />
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* desktop sidebar */}
        <aside className="hidden lg:flex h-dvh w-[200px] shrink-0 flex-col border-l border-[#1B2946]/70 bg-[#0A1020] no-print">
          <Sidebar activeView={activeView} />
        </aside>

        {/* mobile sidebar drawer */}
        {mobileNavOpen && (
          <div className="lg:hidden fixed inset-0 z-50 no-print" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/60" onClick={() => setMobileNavOpen(false)} />
            <div className="absolute top-0 bottom-0 right-0 w-64 bg-[#0A1020] border-l border-[#1B2946] overflow-y-auto">
              <Sidebar activeView={activeView} onNavigate={() => setMobileNavOpen(false)} />
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <Topbar user={user} onLogout={onLogout} />
          <main className="flex-1 px-3 sm:px-5 py-4 pb-24 lg:pb-0 max-w-[1400px] w-full mx-auto">
            {renderView()}
          </main>
          <div className="hidden lg:block no-print">
            <Footer />
          </div>
        </div>
      </div>

      {/* mobile bottom nav (app-like navigation) */}
      <MobileBottomNav />
    </div>
  );
}

function MobileBottomNav() {
  const activeView = useApp((s) => s.activeView);
  const setView = useApp((s) => s.setView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const items: { key: ViewKey; label: string; icon: React.ReactNode }[] = [
    { key: "dashboard", label: t("home"), icon: <NavIcon d="M3 10.5 12 3l9 7.5V21H3z" /> },
    { key: "servers", label: t("servers"), icon: <NavIcon d="M4 5h16v5H4zM4 14h16v5H4z" /> },
    { key: "users", label: t("users"), icon: <NavIcon d="M16 14a4 4 0 0 0-8 0M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 20c0-3 3.6-4 8-4s8 1 8 4" /> },
    { key: "cards", label: t("cards"), icon: <NavIcon d="M3 7h18v10H3zM7 12h5" /> },
    { key: "payments", label: t("payments"), icon: <NavIcon d="M3 8h18v8H3zM3 11h18" /> },
  ];
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0D1528]/97 backdrop-blur border-t border-[#1B2946] no-print pb-[env(safe-area-inset-bottom)]" aria-label="main mobile navigation">
      <div className="grid grid-cols-5">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => setView(it.key)}
            className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-semibold transition-colors ${activeView === it.key ? "text-[#1685FF]" : "text-[#64748B]"}`}
          >
            <span className={activeView === it.key ? "drop-shadow-[0_0_6px_rgba(22,133,255,0.8)]" : ""}>{it.icon}</span>
            {it.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
