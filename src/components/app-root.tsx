"use client";

import { useEffect, useState } from "react";
import { api, clearStoredToken, useApp } from "@/lib/store";
import { LoginView } from "@/components/login-view";
import { AppShell } from "@/components/shell/app-shell";
import { Loader2, AlertTriangle } from "lucide-react";

interface OrgInfo {
  code: string;
  name: string;
  plan: string;
  subscriptionStatus: string;
  brandName: string | null;
  brandPrimary: string | null;
  logoUrl: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

const DAY_MS = 24 * 3600 * 1000;

/** Subscription state banner — informational only (never blocks the UI). */
function SubscriptionBanner({ org }: { org: OrgInfo | null }) {
  if (!org) return null;
  if (org.subscriptionStatus === "suspended") {
    return (
      <div className="bg-[#EF4444] text-white text-xs font-bold text-center px-4 py-2.5">
        🚫 تم تعليق الاشتراك — اتصل بمسؤول المنصة للتفعيل
      </div>
    );
  }
  if (org.subscriptionStatus === "past_due") {
    return (
      <div className="bg-[#F59E0B] text-[#0A1020] text-xs font-bold text-center px-4 py-2.5">
        <AlertTriangle className="w-3.5 h-3.5 inline align-[-2px] me-1" />
        الاشتراك متأخر — جَدِّد لتفادي التعليق
      </div>
    );
  }
  if (org.subscriptionStatus === "trialing" && org.trialEndsAt) {
    const days = Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / DAY_MS);
    if (days <= 7) {
      return (
        <div className="bg-[#F59E0B] text-[#0A1020] text-xs font-bold text-center px-4 py-2.5">
          <AlertTriangle className="w-3.5 h-3.5 inline align-[-2px] me-1" />
          {days > 0
            ? `الفترة التجريبية تنتهي خلال ${days} يوم — قم بالترقية للاستمرار`
            : "انتهت الفترة التجريبية — قم بالترقية للاستمرار"}
        </div>
      );
    }
  }
  return null;
}

export function AppRoot() {
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; name: string; role: string } | null>(null);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const setLang = useApp((s) => s.setLang);

  useEffect(() => {
    // restore language preference
    const saved = typeof window !== "undefined" ? localStorage.getItem("mtcm_lang") : null;
    if (saved === "en") setLang("en");
    // register PWA service worker (mobile + desktop installable app)
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    api<{ user: { id: string; name: string; role: string } | null; org?: OrgInfo | null }>("/api/auth/me")
      .then((d) => {
        setUser(d.user);
        const meOrg = (d as { org?: { id?: string } }).org;
        if (meOrg?.id) localStorage.setItem("mtcm_org_id", meOrg.id);
        else localStorage.removeItem("mtcm_org_id");
        setOrg(d.org ?? null);
      })
      .catch(() => setUser(null))
      .finally(() => {
        // if the session check says "no valid session", drop any stale Bearer token too
        setUser((u) => {
          if (!u) clearStoredToken();
          return u;
        });
        setChecking(false);
      });
  }, [setLang]);

  useEffect(() => {
    if (user) localStorage.setItem("mtcm_user_name", user.name);
  }, [user]);

  // any API returning 401 (expired/invalid session) sends this event → back to login
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("mtcm_unauthorized", onUnauthorized);
    return () => window.removeEventListener("mtcm_unauthorized", onUnauthorized);
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen bg-[#0A1020] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#1685FF]" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginView
        onSuccess={(u) => {
          setUser(u);
          // pick up the freshly established session's organization for the banner
          api<{ org?: OrgInfo | null }>("/api/auth/me")
            .then((d) => setOrg(d.org ?? null))
            .catch(() => {});
        }}
      />
    );
  }

  return (
    <>
      <SubscriptionBanner org={org} />
      <AppShell user={user} onLogout={() => setUser(null)} />
    </>
  );
}
