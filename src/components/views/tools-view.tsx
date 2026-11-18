"use client";

import { useEffect, useState } from "react";
import { api, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, TerminalSquare, Search, ArrowRightLeft, ListTree, Globe } from "lucide-react";

interface Rtr { id: string; name: string; status: string }

const TOOLS = [
  { key: "ping", labelAr: "Ping", labelEn: "Ping", icon: <ArrowRightLeft className="w-4 h-4" />, needsAddress: true },
  { key: "traceroute", labelAr: "تتبع المسار", labelEn: "Traceroute", icon: <ListTree className="w-4 h-4" />, needsAddress: true },
  { key: "dns", labelAr: "استعلام DNS", labelEn: "DNS lookup", icon: <Globe className="w-4 h-4" />, needsAddress: true },
  { key: "arp", labelAr: "جدول ARP", labelEn: "ARP table", icon: <Search className="w-4 h-4" />, needsAddress: false },
  { key: "dhcp", labelAr: "عقود DHCP", labelEn: "DHCP leases", icon: <Search className="w-4 h-4" />, needsAddress: false },
  { key: "routes", labelAr: "جدول التوجيه", labelEn: "Routing table", icon: <ListTree className="w-4 h-4" />, needsAddress: false },
  { key: "connections", labelAr: "الاتصالات النشطة", labelEn: "Connections", icon: <TerminalSquare className="w-4 h-4" />, needsAddress: false },
];

export function ToolsView() {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [routers, setRouters] = useState<Rtr[]>([]);
  const [routerId, setRouterId] = useState("");
  const [tool, setTool] = useState("ping");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; summary?: string; rows: Record<string, string>[] } | null>(null);

  useEffect(() => {
    api<{ routers: Rtr[] }>("/api/routers").then((d) => {
      setRouters(d.routers);
      if (d.routers[0]) setRouterId(d.routers[0].id);
    }).catch(() => {});
  }, []);

  async function run() {
    const needsAddress = TOOLS.find((x) => x.key === tool)?.needsAddress;
    if (needsAddress && !address) {
      toast.error(lang === "ar" ? "أدخل العنوان" : "Enter an address");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await api<{ ok: boolean; summary: string; rows: Record<string, string>[] }>("/api/tools", {
        method: "POST",
        json: { tool, routerId, address },
      });
      setResult(res);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const currentTool = TOOLS.find((x) => x.key === tool)!;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold text-white">{t("tools")}</h1>

      <div className="panel p-4 space-y-3">
        <div className="text-[11px] text-[#8CA3C3] bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2.5 leading-relaxed">
          {lang === "ar"
            ? "تُنفّذ الأوامر فعلياً على السيرفر المحدد عبر RouterOS API (يُشترط أن يكون السيرفر متصلاً بعد اختبار ناجح)."
            : "Commands execute for real on the selected router via the RouterOS API (the router must be online after a successful test)."}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={routerId} onChange={(e) => setRouterId(e.target.value)} className="bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white">
            {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div className="flex flex-wrap gap-1.5">
            {TOOLS.map((tl) => (
              <button
                key={tl.key}
                onClick={() => setTool(tl.key)}
                className={`flex items-center gap-1.5 text-[11px] font-bold rounded-lg px-2.5 py-1.5 border transition-colors ${tool === tl.key ? "bg-[#1685FF] border-[#1685FF] text-white" : "bg-[#0B1428] border-[#24344F] text-[#CBD5E1] hover:bg-[#17243B]"}`}
              >
                {tl.icon} {lang === "ar" ? tl.labelAr : tl.labelEn}
              </button>
            ))}
          </div>
          {currentTool.needsAddress && (
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={lang === "ar" ? "8.8.8.8 أو example.com" : "8.8.8.8 or example.com"}
              dir="ltr"
              className="flex-1 min-w-[160px] max-w-xs bg-[#0B1428] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#1685FF]"
            />
          )}
          <Button onClick={run} disabled={busy} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TerminalSquare className="w-3.5 h-3.5" />}
            {lang === "ar" ? "تنفيذ" : "Run"}
          </Button>
        </div>
      </div>

      {busy && <Skeleton className="h-40 rounded-xl bg-[#111C33]" />}

      {!busy && result && (
        <div className="panel p-4">
          <div className={`text-xs font-bold mb-3 ${result.ok ? "text-emerald-300" : "text-red-300"}`}>
            {result.ok ? result.summary : (result.summary ?? (lang === "ar" ? "فشل التنفيذ — تأكد من اتصال السيرفر" : "Execution failed"))}
          </div>
          {result.rows.length > 0 && (
            <div className="bg-[#050B18] border border-[#1B2946] rounded-lg p-3 max-h-72 overflow-auto font-mono text-[10.5px] leading-relaxed" dir="ltr">
              {result.rows.map((r, i) => (
                <div key={i} className="text-emerald-200/80">
                  {Object.entries(r).map(([k, v]) => `${k}=${v}`).join("  ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
