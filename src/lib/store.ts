"use client";

import { create } from "zustand";
import type { Lang } from "@/lib/i18n";

export type ViewKey =
  | "dashboard" | "servers" | "users" | "packages" | "monitoring" | "reports"
  | "payments" | "cards" | "settings" | "tools" | "support"
  | "devices" | "topology" | "consumption"
  | "subscribers" | "finance" | "branches" | "ros" | "agents";

interface AppState {
  lang: Lang;
  activeView: ViewKey;
  setLang: (l: Lang) => void;
  setView: (v: ViewKey) => void;
}

export const useApp = create<AppState>((set) => ({
  lang: "ar",
  activeView: (typeof window !== "undefined" && localStorage.getItem("mtcm_view") as ViewKey) || "dashboard",
  setLang: (lang) => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    set({ lang });
  },
  setView: (activeView) => {
    try { localStorage.setItem("mtcm_view", activeView); } catch {}
    set({ activeView });
  },
}));

/* ------------------------------------------------------------------ */
/* Auth token storage — Bearer fallback for cookie-blocked contexts    */
/* (cross-origin preview iframes drop SameSite cookies entirely).      */
/* ------------------------------------------------------------------ */
const TOKEN_KEY = "mtcm_token";

export function getStoredToken(): string | null {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/** fetch with Authorization header (Bearer fallback for cookie-blocked preview iframes). */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers, cache: "no-store" });
}

/** small fetch helper with unified error handling */
export async function api<T = unknown>(
  url: string,
  options?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = options ?? {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  const token = getStoredToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // session expired / revoked → drop token and let the shell show the login screen
    if (res.status === 401 && !url.includes("/api/auth/login")) {
      clearStoredToken();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("mtcm_unauthorized"));
    }
    throw new Error((data as { error?: string }).error || `فشل الطلب (${res.status})`);
  }
  return data as T;
}

export const fmtNum = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US").format(n);

export const fmtMoney = (n: number | null | undefined, currency = "USD") =>
  currency === "USD" ? `$ ${new Intl.NumberFormat("en-US").format(Math.round((n ?? 0) * 100) / 100)}` : `${new Intl.NumberFormat("en-US").format(Math.round((n ?? 0) * 100) / 100)} ${currency}`;

export const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

export const fmtDateTime = (d: string | Date) => {
  const dt = typeof d === "string" ? new Date(d) : d;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
};

export const fmtDate = (d: string | Date) => {
  const dt = typeof d === "string" ? new Date(d) : d;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
