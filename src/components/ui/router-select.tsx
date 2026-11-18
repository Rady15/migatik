"use client";

import { useEffect, useState } from "react";
import { api, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { ChevronDown, Server } from "lucide-react";

export interface RouterOption {
  id: string;
  name: string;
  status: string;
}

interface RouterSelectProps {
  /** "all" or a router id */
  value: string;
  onChange: (id: string) => void;
  className?: string;
  /** reuse a router list already loaded by the parent instead of fetching it */
  routers?: RouterOption[];
  disabled?: boolean;
}

/**
 * Server picker used in every section that has server-related data.
 * The selection is local to each section (independent per section).
 */
export function RouterSelect({ value, onChange, className = "", routers: external, disabled }: RouterSelectProps) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [internal, setInternal] = useState<RouterOption[]>([]);
  const routers = external ?? internal;

  useEffect(() => {
    if (external) return;
    let alive = true;
    const load = () =>
      api<{ routers: RouterOption[] }>("/api/routers")
        .then((d) => alive && setInternal(d.routers))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [external]);

  return (
    <div className={`relative ${className}`}>
      <Server className="w-3.5 h-3.5 text-[#5B7194] absolute top-1/2 -translate-y-1/2 start-2.5 pointer-events-none" />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("router")}
        className="w-full bg-[#0E1A31] border border-[#24344F] rounded-lg ps-8 pe-7 py-2 text-xs text-white outline-none focus:border-[#1685FF] disabled:opacity-50 appearance-none cursor-pointer"
      >
        <option value="all">{t("allServers")}</option>
        {routers.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.status && r.status !== "online" ? ` (${t("offlineShort")})` : ""}
          </option>
        ))}
      </select>
      <ChevronDown className="w-3.5 h-3.5 text-[#5B7194] absolute top-1/2 -translate-y-1/2 end-2 pointer-events-none" />
    </div>
  );
}
