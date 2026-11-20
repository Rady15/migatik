"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, api, fmtDateTime, clearStoredToken } from "@/lib/store";
import { makeT, type Lang } from "@/lib/i18n";
import { Bell, Moon, Sun, Globe, ChevronDown, LogOut, User, Download, CheckCheck, Loader2, AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

interface Notif {
  id: string;
  title: string;
  body: string | null;
  type: string;
  severity: string;
  read: boolean;
  createdAt: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

export function Topbar({ user, onLogout }: { user: { name: string; role: string }; onLogout: () => void }) {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const t = makeT(lang);
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [openNotif, setOpenNotif] = useState(false);
  const [openUser, setOpenUser] = useState(false);
  const [openLang, setOpenLang] = useState(false);
  const [light, setLight] = useState(false);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);

  // Restore the theme chosen with the toggle (or from Settings) after a reload.
  useEffect(() => {
    const saved = localStorage.getItem("mtcm_theme");
    const isLight = saved === "light" || document.documentElement.classList.contains("light");
    setLight(isLight);
    document.documentElement.classList.toggle("light", isLight);
  }, []);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadNotifs = () =>
    api<{ notifications: Notif[]; unread: number }>("/api/notifications")
      .then((d) => { setNotifs(d.notifications); setUnread(d.unread); })
      .catch(() => {});

  useEffect(() => {
    loadNotifs();
    const timer = setInterval(loadNotifs, 30000);
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenNotif(false);
        setOpenUser(false);
        setOpenLang(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function markAll() {
    setBusy(true);
    try {
      await api("/api/notifications", { method: "PATCH", json: {} });
      await loadNotifs();
    } finally {
      setBusy(false);
    }
  }

  function toggleTheme() {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    try { localStorage.setItem("mtcm_theme", next ? "light" : "dark"); } catch { /* private mode */ }
    void api("/api/settings", { method: "PUT", json: { theme: next ? "light" : "dark" } }).catch(() => {});
  }

  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    setInstallEvt(null);
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {}
    clearStoredToken();
    onLogout();
  }

  const sevIcon = (sev: string) =>
    sev === "success" ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
    : sev === "warning" ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
    : sev === "danger" ? <XCircle className="w-4 h-4 text-red-400 shrink-0" />
    : <Info className="w-4 h-4 text-blue-400 shrink-0" />;

  return (
    <header className="relative z-30 bg-[#0A1020]/90 backdrop-blur border-b border-[#1B2946]/70 h-[64px] flex items-center px-3 sm:px-5 no-print">
      {/* status pill — centered like the design */}
      <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 items-center gap-2 bg-emerald-500/10 border border-emerald-500/25 rounded-full px-3.5 py-1.5">
        <span className="dot dot-green" />
        <span className="text-emerald-300 text-[12px] font-bold">{t("systemOk")}</span>
      </div>

      <div className="flex-1" />

      {/* controls (left in the design) */}
      <div className="flex items-center gap-2 sm:gap-3" ref={ref}>
        {/* language */}
        <div className="relative">
          <button
            onClick={() => { setOpenLang(!openLang); setOpenNotif(false); setOpenUser(false); }}
            className="flex items-center gap-1.5 text-[#CBD5E1] hover:text-white text-[12.5px] font-bold transition-colors"
            aria-label="language"
          >
            <Globe className="w-4 h-4 text-[#7E93B4]" />
            <span>{lang === "ar" ? "العربية" : "English"}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#7E93B4]" />
          </button>
          {openLang && (
            <div className="absolute top-8 end-0 panel p-1 w-32 shadow-2xl">
              {(["ar", "en"] as Lang[]).map((l) => (
                <button
                  key={l}
                  onClick={() => { setLang(l); localStorage.setItem("mtcm_lang", l); setOpenLang(false); }}
                  className={`w-full text-start px-3 py-2 rounded-md text-xs font-semibold hover:bg-[#17243B] ${lang === l ? "text-[#1685FF]" : "text-[#CBD5E1]"}`}
                >
                  {l === "ar" ? "العربية (RTL)" : "English (LTR)"}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* theme */}
        <button onClick={toggleTheme} aria-label="toggle theme" className="text-[#7E93B4] hover:text-white transition-colors">
          {light ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* notifications */}
        <div className="relative">
          <button
            onClick={() => { setOpenNotif(!openNotif); setOpenUser(false); setOpenLang(false); }}
            className="relative text-[#7E93B4] hover:text-white transition-colors"
            aria-label={t("notifications")}
          >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute -top-1.5 -end-1.5 bg-[#EF4444] text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center num">
                {unread}
              </span>
            )}
          </button>
          {openNotif && (
            <div className="absolute top-9 end-0 w-[320px] max-w-[85vw] panel shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1B2946]">
                <span className="text-xs font-bold text-white">{t("notifications")}</span>
                <button onClick={markAll} disabled={busy} className="text-[10.5px] text-[#1685FF] hover:text-[#5CA9FF] flex items-center gap-1 font-semibold">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCheck className="w-3 h-3" />}
                  {t("markAllRead")}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {notifs.length === 0 && <div className="p-4 text-xs text-[#64748B] text-center">{t("noNotifications")}</div>}
                {notifs.map((n) => (
                  <div key={n.id} className={`px-3 py-2.5 border-b border-[#1B2946]/60 hover:bg-[#131F38] ${!n.read ? "bg-[#10203A]/60" : ""}`}>
                    <div className="flex items-start gap-2">
                      {sevIcon(n.severity)}
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-bold text-[#E2E8F0]">{n.title}</div>
                        {n.body && <div className="text-[10.5px] text-[#8CA3C3] mt-0.5 leading-relaxed">{n.body}</div>}
                        <div className="text-[9.5px] text-[#55688A] mt-1 num" dir="ltr">{fmtDateTime(n.createdAt)}</div>
                      </div>
                      {!n.read && <span className="dot dot-green shrink-0 mt-1.5" />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* user */}
        <div className="relative">
          <button
            onClick={() => { setOpenUser(!openUser); setOpenNotif(false); setOpenLang(false); }}
            className="flex items-center gap-2.5 ps-1"
            aria-label="user menu"
          >
            <div className="relative">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1685FF] to-[#0B55B8] flex items-center justify-center text-white font-extrabold text-sm">
                {user.name.trim().charAt(0)}
              </div>
              <span className="absolute bottom-0 end-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#0A1020]" />
            </div>
            <div className="hidden sm:block text-start leading-tight">
              <div className="text-white text-[13px] font-bold">{user.name}</div>
              <div className="text-[#7E93B4] text-[10.5px]" dir="ltr">Administrator</div>
            </div>
          </button>
          {openUser && (
            <div className="absolute top-12 end-0 w-44 panel p-1.5 shadow-2xl">
              <div className="px-3 py-2 border-b border-[#1B2946]">
                <div className="text-xs font-bold text-white">{user.name}</div>
                <div className="text-[10px] text-[#7E93B4]">{user.role}</div>
              </div>
              <button onClick={() => setOpenUser(false)} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs text-[#CBD5E1] hover:bg-[#17243B]">
                <User className="w-3.5 h-3.5" /> {t("profile")}
              </button>
              {installEvt && (
                <button onClick={install} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs text-[#22D3EE] hover:bg-[#17243B] font-semibold">
                  <Download className="w-3.5 h-3.5" /> {t("installApp")}
                </button>
              )}
              <button onClick={logout} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs text-[#FCA5A5] hover:bg-[#2A1520]">
                <LogOut className="w-3.5 h-3.5" /> {t("logout")}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
