"use client";

import { useEffect, useState } from "react";
import { api, setStoredToken } from "@/lib/store";
import { Loader2, Wifi } from "lucide-react";

interface OrgBrand {
  brandName: string | null;
  brandPrimary: string | null;
  logoUrl: string | null;
}

const BRAND_KEY = "mtcm_brand";

export function LoginView({ onSuccess }: { onSuccess: (u: { id: string; name: string; role: string }) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [brand, setBrand] = useState<OrgBrand | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  // restore branding persisted from a previous login (repeat visits / session expiry)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BRAND_KEY);
      if (raw) setBrand(JSON.parse(raw) as OrgBrand);
    } catch {}
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ ok: boolean; token?: string; user: { id: string; name: string; role: string }; org?: OrgBrand | null }>(
        "/api/auth/login",
        { method: "POST", json: { username, password } },
      );
      if (res.token) setStoredToken(res.token);
      // org branding rides on the login response — apply + persist for future visits
      if (res.org) {
        setBrand(res.org);
        try { localStorage.setItem(BRAND_KEY, JSON.stringify(res.org)); } catch {}
      }
      onSuccess(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const primary = brand?.brandPrimary || null;
  const showLogo = Boolean(brand?.logoUrl) && !logoFailed;

  return (
    <div className="min-h-screen bg-[#0A1020] flex items-center justify-center p-4 relative overflow-hidden">
      {/* decorative glows */}
      <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1685FF]/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-[#22D3EE]/10 blur-3xl pointer-events-none" />

      <div className="w-full max-w-sm panel p-7 relative z-10">
        <div className="flex flex-col items-center gap-1 mb-6">
          {showLogo ? (
            <img
              src={brand!.logoUrl!}
              alt={brand?.brandName || "logo"}
              onError={() => setLogoFailed(true)}
              className="w-14 h-14 rounded-2xl object-cover mb-2 shadow-lg bg-[#0B1428]"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#1685FF] to-[#0B5ED7] flex items-center justify-center mb-2 shadow-lg shadow-[#1685FF]/30"
              style={primary ? { background: primary } : undefined}
            >
              <Wifi className="w-7 h-7 text-white" />
            </div>
          )}
          <div className="text-white font-extrabold text-2xl tracking-wide">{brand?.brandName || "MikroTik"}</div>
          <div className="text-[#8CA3C3] text-xs">Management System — نظام إدارة الشبكات</div>
        </div>

        <h1 className="text-white font-bold text-lg mb-1 text-center">تسجيل الدخول</h1>
        <p className="text-[#8CA3C3] text-xs mb-5 text-center">أدخل بياناتك للوصول إلى لوحة الإدارة</p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-[#8CA3C3] mb-1 block">اسم المستخدم</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-[#1685FF] transition-colors"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="text-xs text-[#8CA3C3] mb-1 block">كلمة المرور</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-[#1685FF] transition-colors"
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div className="bg-[#EF4444]/10 border border-[#EF4444]/30 text-[#FCA5A5] text-xs rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={primary ? { background: primary } : undefined}
            className="w-full bg-gradient-to-l from-[#1685FF] to-[#0B62D9] hover:from-[#3B97FF] hover:to-[#1671E3] text-white font-bold text-sm rounded-lg py-2.5 flex items-center justify-center gap-2 transition-all disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            دخول
          </button>
        </form>
      </div>
    </div>
  );
}
