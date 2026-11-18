"use client";

import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { fmtNum } from "@/lib/store";
import { ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import type { DashboardData } from "./dashboard-view";

export function StatusDonut({ status, total }: { status: DashboardData["userStatus"]; total: number }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  const data = [
    { key: "online", label: t("online"), value: status.online, color: "#10B981" },
    { key: "suspended", label: t("suspended"), value: status.suspended, color: "#F59E0B" },
    { key: "expired", label: t("expired"), value: status.expired, color: "#EF4444" },
  ].filter((d) => d.value > 0);

  return (
    <div className="panel p-4 h-full min-h-[250px] flex flex-col">
      <div className="text-center panel-title text-white">{t("userStatus")}</div>
      <div className="flex-1 flex items-center gap-1 relative min-h-[170px]">
        <div className="absolute inset-0" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                innerRadius="58%"
                outerRadius="82%"
                startAngle={90}
                endAngle={-270}
                paddingAngle={1}
                stroke="none"
                animationDuration={900}
              >
                {data.map((d) => (
                  <Cell key={d.key} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        {/* center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-white font-extrabold text-xl num" dir="ltr">{fmtNum(total)}</div>
          <div className="text-[#8CA3C3] text-[11px] font-bold">{t("total")}</div>
        </div>
        {/* legend (start side = right in RTL, matching the design) */}
        <div className="absolute top-1/2 -translate-y-1/2 start-2 space-y-2.5">
          {data.map((d) => (
            <div key={d.key} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
              <span className="text-[11.5px] font-bold text-[#CBD5E1]">{d.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
