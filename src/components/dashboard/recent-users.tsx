"use client";

import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { fmtDuration, fmtDateTime } from "@/lib/store";
import { UserRound } from "lucide-react";
import type { DashboardData } from "./dashboard-view";

export function RecentUsers({ users }: { users: DashboardData["recentUsers"] }) {
  const setView = useApp((s) => s.setView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  return (
    <div className="panel p-4 h-full">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setView("users")}
          className="bg-[#17243B] hover:bg-[#223351] border border-[#2E4166] text-[#CBD5E1] text-[11.5px] font-bold rounded-lg px-3 py-1.5 transition-colors"
        >
          {t("viewAll")}
        </button>
        <div className="panel-title text-white">{t("recentUsers")}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="mt-table w-full min-w-[540px]">
          <thead>
            <tr>
              <th className="w-8"><UserRound className="w-3.5 h-3.5 text-[#5B7194]" /></th>
              <th>{t("username")}</th>
              <th>{t("speed")}</th>
              <th>{t("connStatus")}</th>
              <th>{t("duration")}</th>
              <th>{t("date")}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={6} className="text-center text-[#64748B] py-6">{t("noData")}</td></tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-[#121E38]/70 transition-colors">
                <td><UserRound className="w-4 h-4 text-[#5B7194]" /></td>
                <td className="font-bold text-[#E2E8F0]">{u.username}</td>
                <td className="text-[#CBD5E1] num" dir="ltr">{u.speed}</td>
                <td>
                  <span className="inline-block bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-[10.5px] font-bold rounded-full px-2.5 py-0.5 shadow-[0_0_8px_rgba(16,185,129,0.35)]">
                    {t("online")}
                  </span>
                </td>
                <td className="text-[#CBD5E1] num" dir="ltr">{fmtDuration(u.durationSec)}</td>
                <td className="text-[#8CA3C3] num" dir="ltr">{fmtDateTime(u.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
