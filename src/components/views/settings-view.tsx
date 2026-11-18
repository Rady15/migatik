"use client";

import { useEffect, useState } from "react";
import { api, useApp, fmtDate } from "@/lib/store";
import { makeT, type Lang } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DlgField } from "./packages-view";
import { Loader2, Download, Save, Moon, Sun, Languages, ShieldCheck, Building2, Palette, Radio, Users, Ticket } from "lucide-react";

interface OrgProfile {
  org: {
    id: string;
    code: string;
    name: string;
    plan: string;
    subscriptionStatus: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    maxRouters: number;
    maxUsers: number;
    maxVouchersPerBatch: number;
    brandName: string | null;
    brandPrimary: string | null;
    logoUrl: string | null;
  };
  usage: {
    routers: number;
    users: number;
    subscribers: number;
    usage30d: { routers: number; devicesOnlineMax: number; vouchersGenerated: number };
  };
}

function planLabel(plan: string, lang: Lang): string {
  const map: Record<string, string> = { trial: "تجريبي", starter: "Starter", pro: "Pro", enterprise: "Enterprise" };
  return map[plan] ?? plan;
}

function StatusBadge({ status, trialEndsAt, lang }: { status: string; trialEndsAt: string | null; lang: Lang }) {
  const map: Record<string, { label: string; cls: string }> = {
    trialing: { label: lang === "ar" ? "تجريبي" : "Trial", cls: "bg-[#1685FF]/15 text-[#5CA9FF] border-[#1685FF]/30" },
    active: { label: lang === "ar" ? "نشط" : "Active", cls: "bg-[#0FA36B]/15 text-[#34D399] border-[#0FA36B]/30" },
    past_due: { label: lang === "ar" ? "متأخر" : "Past due", cls: "bg-[#F59E0B]/15 text-[#FBBF24] border-[#F59E0B]/30" },
    suspended: { label: lang === "ar" ? "معلق" : "Suspended", cls: "bg-[#EF4444]/15 text-[#FCA5A5] border-[#EF4444]/30" },
    canceled: { label: lang === "ar" ? "ملغي" : "Canceled", cls: "bg-[#64748B]/15 text-[#94A3B8] border-[#64748B]/30" },
  };
  const s = map[status] ?? { label: status, cls: "bg-[#64748B]/15 text-[#94A3B8] border-[#64748B]/30" };
  const extra = status === "trialing" && trialEndsAt ? ` · ${lang === "ar" ? "تنتهي في" : "ends"} ${fmtDate(trialEndsAt)}` : "";
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${s.cls}`}>{s.label}{extra}</span>;
}

function LimitRow({ label, icon, used, max }: { label: string; icon: React.ReactNode; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const danger = pct >= 90;
  return (
    <div className="bg-[#0B1428]/60 border border-[#24344F]/60 rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#8CA3C3] flex items-center gap-1.5">{icon}{label}</span>
        <span className={danger ? "text-[#FCA5A5] font-bold" : "text-[#CBD5E1] font-bold"} dir="ltr">{used} / {max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[#111C33] border border-[#24344F]/60 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${danger ? "bg-[#EF4444]" : "bg-[#1685FF]"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SettingsView({ user }: { user: { id: string; name: string; role: string } }) {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const t = makeT(lang);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [savingPass, setSavingPass] = useState(false);
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<void> } | null>(null);
  const [orgData, setOrgData] = useState<OrgProfile | null>(null);
  const [orgError, setOrgError] = useState("");
  const [brandName, setBrandName] = useState("");
  const [brandPrimary, setBrandPrimary] = useState("#1685FF");
  const [logoUrl, setLogoUrl] = useState("");
  const [savingBrand, setSavingBrand] = useState(false);

  useEffect(() => {
    api<OrgProfile>("/api/org")
      .then((d) => {
        setOrgData(d);
        setBrandName(d.org.brandName ?? "");
        setBrandPrimary(d.org.brandPrimary ?? "#1685FF");
        setLogoUrl(d.org.logoUrl ?? "");
      })
      .catch((e) => setOrgError((e as Error).message));
  }, []);

  useEffect(() => {
    api<{ settings: Record<string, string> }>("/api/settings").then((d) => setSettings(d.settings)).catch((e) => toast.error((e as Error).message));
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as unknown as { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function saveOrg() {
    setSavingOrg(true);
    try {
      await api("/api/settings", { method: "PUT", json: { ...settings, name } });
      toast.success(t("saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingOrg(false);
    }
  }

  async function savePassword() {
    if (!newPassword) {
      toast.error(lang === "ar" ? "أدخل كلمة المرور الجديدة" : "Enter the new password");
      return;
    }
    setSavingPass(true);
    try {
      await api("/api/settings", { method: "PUT", json: { currentPassword, newPassword } });
      toast.success(t("saved"));
      setCurrentPassword("");
      setNewPassword("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingPass(false);
    }
  }

  async function saveBrand() {
    setSavingBrand(true);
    try {
      const res = await api<{ ok: boolean; message: string }>("/api/org", {
        method: "PATCH",
        json: { brandName, brandPrimary, logoUrl },
      });
      toast.success(res.message || t("saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingBrand(false);
    }
  }

  async function install() {
    if (!installEvt) {
      toast.info(lang === "ar"
        ? "التثبيت متاح من قائمة المتصفح: «تثبيت التطبيق» / «Install app»"
        : "Install from your browser menu: 'Install app'");
      return;
    }
    await installEvt.prompt();
  }

  if (!settings) return <Skeleton className="h-96 rounded-xl bg-[#111C33]" />;

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-lg font-extrabold text-white">{t("settings")}</h1>

      {/* my organization — SaaS subscription & branding */}
      <div className="panel p-4 space-y-3">
        <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
          <Building2 className="w-4 h-4 text-[#1685FF]" /> {lang === "ar" ? "منظمتي" : "My organization"}
        </h2>
        {orgError && (
          <div className="text-[11px] text-[#FCA5A5] bg-[#EF4444]/10 border border-[#EF4444]/30 rounded-lg px-3 py-2">{orgError}</div>
        )}
        {!orgData && !orgError && <Skeleton className="h-44 rounded-xl bg-[#111C33]" />}
        {orgData && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-white font-bold">{orgData.org.name}</span>
              <span className="text-[10px] text-[#64748B] font-mono" dir="ltr">{orgData.org.code}</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-[#1685FF]/15 text-[#5CA9FF] border-[#1685FF]/30">
                {lang === "ar" ? "الخطة" : "Plan"}: {planLabel(orgData.org.plan, lang)}
              </span>
              <StatusBadge status={orgData.org.subscriptionStatus} trialEndsAt={orgData.org.trialEndsAt} lang={lang} />
            </div>

            {orgData.org.subscriptionStatus === "trialing" && orgData.org.trialEndsAt && (
              <p className="text-[11px] text-[#FBBF24]">
                ⏳ {lang === "ar"
                  ? `تنتهي الفترة التجريبية في ${fmtDate(orgData.org.trialEndsAt)} (متبقٍ ${Math.max(0, Math.ceil((new Date(orgData.org.trialEndsAt).getTime() - Date.now()) / 86400000))} يوم)`
                  : `Trial ends ${fmtDate(orgData.org.trialEndsAt)} (${Math.max(0, Math.ceil((new Date(orgData.org.trialEndsAt).getTime() - Date.now()) / 86400000))} day(s) left)`}
              </p>
            )}
            {orgData.org.subscriptionStatus === "active" && orgData.org.currentPeriodEnd && (
              <p className="text-[11px] text-[#64748B]">
                {lang === "ar" ? `تجديد الفترة الحالية في ${fmtDate(orgData.org.currentPeriodEnd)}` : `Current period renews on ${fmtDate(orgData.org.currentPeriodEnd)}`}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <LimitRow
                label={lang === "ar" ? "الراوترات" : "Routers"}
                icon={<Radio className="w-3 h-3" />}
                used={orgData.usage.routers}
                max={orgData.org.maxRouters}
              />
              <LimitRow
                label={lang === "ar" ? "المستخدمون" : "Users"}
                icon={<Users className="w-3 h-3" />}
                used={orgData.usage.users}
                max={orgData.org.maxUsers}
              />
              <LimitRow
                label={lang === "ar" ? "كروت (30 يوم)" : "Vouchers (30d)"}
                icon={<Ticket className="w-3 h-3" />}
                used={orgData.usage.usage30d.vouchersGenerated}
                max={orgData.org.maxVouchersPerBatch}
              />
            </div>
            <p className="text-[10.5px] text-[#64748B]">
              {lang === "ar"
                ? `المشتركون: ${orgData.usage.subscribers} · ذروة الأجهزة المتصلة (30 يوم): ${orgData.usage.usage30d.devicesOnlineMax}`
                : `Subscribers: ${orgData.usage.subscribers} · Peak devices online (30d): ${orgData.usage.usage30d.devicesOnlineMax}`}
            </p>

            <div className="border-t border-[#24344F]/60 pt-3 space-y-3">
              <h3 className="text-xs font-bold text-[#CBD5E1] flex items-center gap-2">
                <Palette className="w-3.5 h-3.5 text-[#22D3EE]" /> {lang === "ar" ? "هوية المؤسسة (شاشة تسجيل الدخول)" : "Branding (login screen)"}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DlgField
                  label={lang === "ar" ? "اسم العلامة" : "Brand name"}
                  value={brandName}
                  onChange={setBrandName}
                  placeholder={lang === "ar" ? "يظهر بدلاً من MikroTik" : "replaces MikroTik"}
                />
                <DlgField
                  label={lang === "ar" ? "رابط الشعار (https)" : "Logo URL (https)"}
                  value={logoUrl}
                  onChange={setLogoUrl}
                  dir="ltr"
                  placeholder="https://..."
                />
                <div>
                  <label className="text-xs text-[#8CA3C3] mb-1 block">{lang === "ar" ? "اللون الأساسي" : "Primary color"}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={/^#[0-9A-Fa-f]{6}$/.test(brandPrimary) ? brandPrimary : "#1685FF"}
                      onChange={(e) => setBrandPrimary(e.target.value)}
                      className="w-10 h-9 rounded-lg border border-[#24344F] bg-[#0B1428] cursor-pointer p-1"
                      aria-label="brand primary color"
                    />
                    <input
                      value={brandPrimary}
                      onChange={(e) => setBrandPrimary(e.target.value)}
                      dir="ltr"
                      placeholder="#1685FF"
                      className="flex-1 bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF] font-mono"
                    />
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={saveBrand} disabled={savingBrand} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-2">
                  {savingBrand ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {t("save")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* organization */}
      <div className="panel p-4 space-y-3">
        <h2 className="text-sm font-extrabold text-white">{lang === "ar" ? "بيانات المؤسسة" : "Organization"}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <DlgField label={lang === "ar" ? "اسم المؤسسة" : "Organization name"} value={settings.org_name ?? ""} onChange={(v) => setSettings({ ...settings, org_name: v })} />
          <DlgField label={t("phone")} value={settings.org_phone ?? ""} onChange={(v) => setSettings({ ...settings, org_phone: v })} dir="ltr" />
          <DlgField label={lang === "ar" ? "العملة" : "Currency"} value={settings.currency ?? "USD"} onChange={(v) => setSettings({ ...settings, currency: v })} dir="ltr" />
          <DlgField label={lang === "ar" ? "نسبة الضريبة %" : "Tax rate %"} value={settings.tax_rate ?? "14"} onChange={(v) => setSettings({ ...settings, tax_rate: v })} dir="ltr" />
          <DlgField label={lang === "ar" ? "بادئة الكروت" : "Voucher prefix"} value={settings.voucher_prefix ?? "MK"} onChange={(v) => setSettings({ ...settings, voucher_prefix: v })} dir="ltr" />
          <DlgField label={lang === "ar" ? "اسم المدير" : "Administrator name"} value={name} onChange={setName} />
        </div>
        <div className="flex justify-end">
          <Button onClick={saveOrg} disabled={savingOrg} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-2">
            {savingOrg ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {t("save")}
          </Button>
        </div>
      </div>

      {/* appearance & language */}
      <div className="panel p-4 space-y-3">
        <h2 className="text-sm font-extrabold text-white">{lang === "ar" ? "المظهر واللغة" : "Appearance & language"}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => {
              const next = document.documentElement.classList.contains("light") ? "dark" : "light";
              document.documentElement.classList.toggle("light", next === "light");
              setSettings({ ...settings, theme: next });
            }}
            className="text-[#CBD5E1] hover:bg-[#17243B] text-xs gap-2 border border-[#24344F]"
          >
            <Moon className="w-3.5 h-3.5" /> / <Sun className="w-3.5 h-3.5" />
            {lang === "ar" ? "تبديل المظهر" : "Toggle theme"}
          </Button>
          {(["ar", "en"] as const).map((l) => (
            <Button
              key={l}
              variant="ghost"
              onClick={() => { setLang(l); localStorage.setItem("mtcm_lang", l); setSettings({ ...settings, language: l }); }}
              className={`text-xs gap-2 border ${lang === l ? "border-[#1685FF] text-[#5CA9FF]" : "border-[#24344F] text-[#CBD5E1]"} hover:bg-[#17243B]`}
            >
              <Languages className="w-3.5 h-3.5" /> {l === "ar" ? "العربية (RTL)" : "English (LTR)"}
            </Button>
          ))}
          <Button onClick={install} className="bg-[#0FA36B] hover:bg-[#12BE80] text-white font-bold text-xs gap-2">
            <Download className="w-3.5 h-3.5" /> {t("installApp")}
          </Button>
        </div>
        <p className="text-[10.5px] text-[#64748B] leading-relaxed">
          {lang === "ar"
            ? "التطبيق يعمل كـ PWA: يمكن تثبيته كتطبيق موبايل (قائمة إضافة إلى الشاشة الرئيسية) أو كتطبيق سطح مكتب في Chrome/Edge عبر زر التثبيت أعلاه."
            : "This app is a PWA: install it as a mobile app (Add to Home Screen) or as a desktop app in Chrome/Edge using the install button above."}
        </p>
      </div>

      {/* security */}
      <div className="panel p-4 space-y-3">
        <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" /> {lang === "ar" ? "الأمان — تغيير كلمة المرور" : "Security — change password"}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <DlgField label={lang === "ar" ? "كلمة المرور الحالية" : "Current password"} value={currentPassword} onChange={setCurrentPassword} dir="ltr" type="password" />
          <DlgField label={lang === "ar" ? "كلمة المرور الجديدة" : "New password"} value={newPassword} onChange={setNewPassword} dir="ltr" type="password" />
        </div>
        <div className="flex justify-end">
          <Button onClick={savePassword} disabled={savingPass} className="bg-[#0FA36B] hover:bg-[#12BE80] text-white font-bold text-xs gap-2">
            {savingPass ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} {t("save")}
          </Button>
        </div>
        <div className="text-[10.5px] text-[#64748B] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed" dir="ltr">
          • scrypt password hashing · AES-256-GCM router credentials · HMAC-signed httpOnly session cookies · RBAC roles · audit log
        </div>
      </div>
    </div>
  );
}
