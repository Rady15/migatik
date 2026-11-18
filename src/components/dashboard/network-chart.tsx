"use client";

import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import type { DashboardData } from "./dashboard-view";

export function NetworkChart({ data }: { data: DashboardData["network"] }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  return (
    <div className="panel p-4 h-full min-h-[250px] flex flex-col">
      <div className="text-center panel-title text-white mb-1">{t("networkUsage")}</div>
      <div className="flex items-center justify-center gap-4 mb-1">
        <span className="flex items-center gap-1.5 text-[11px] text-[#8CA3C3] font-bold">
          <span className="w-2 h-2 rounded-sm bg-[#1685FF]" /> {t("download")}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-[#8CA3C3] font-bold">
          <span className="w-2 h-2 rounded-sm bg-[#10B981]" /> {t("upload")}
        </span>
      </div>
      <div className="flex-1 min-h-[180px]" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(96,128,180,0.12)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: "#8CA3C3", fontSize: 10 }}
              axisLine={{ stroke: "rgba(96,128,180,0.25)" }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: "#8CA3C3", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={38}
              tickFormatter={(v: number) => `${v}`}
            />
            <Tooltip
              contentStyle={{
                background: "#0D1729",
                border: "1px solid #24344F",
                borderRadius: 10,
                fontSize: 11,
                color: "#F1F5F9",
                direction: "rtl",
              }}
              labelStyle={{ color: "#8CA3C3" }}
              formatter={(value: number, name: string) => [
                `${value} Mbps`,
                name === "download" ? t("download") : t("upload"),
              ]}
            />
            <Line
              type="monotone"
              dataKey="download"
              stroke="#1685FF"
              strokeWidth={2.2}
              dot={{ r: 2.5, fill: "#1685FF", strokeWidth: 0 }}
              activeDot={{ r: 4.5, fill: "#1685FF", stroke: "#fff", strokeWidth: 1.5 }}
              animationDuration={900}
            />
            <Line
              type="monotone"
              dataKey="upload"
              stroke="#10B981"
              strokeWidth={2.2}
              dot={{ r: 2.5, fill: "#10B981", strokeWidth: 0 }}
              activeDot={{ r: 4.5, fill: "#10B981", stroke: "#fff", strokeWidth: 1.5 }}
              animationDuration={900}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
