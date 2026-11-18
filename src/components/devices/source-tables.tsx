"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtDateTime, useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, MoreVertical, RefreshCw, Search, Download, Wifi } from "lucide-react";

interface RouterInfo { id: string; name: string; host: string; status: string; lastSyncAt: string | null; lastSyncOk: boolean | null; lastSyncError: string | null; syncEnabled: boolean; syncIntervalSec: number; identity: string | null }

type SourceKey = "dhcp_leases" | "arp" | "bridge_hosts" | "wireless" | "hotspot_active" | "ppp_active";

interface Row {
  id: string; routerId: string; router: string;
  // dhcp
  ip?: string | null; mac?: string | null; hostname?: string | null; server?: string | null;
  status?: string | null; dynamic?: boolean; blocked?: boolean; disabled?: boolean;
  expiresAt?: string | null; lastSeen?: string | null; pool?: string | null; clientId?: string | null; comment?: string | null;
  // arp
  interface?: string | null; state?: string | null; published?: boolean;
  // bridge
  bridge?: string | null; vlan?: number | null; isLocal?: boolean; externalFdb?: boolean;
  // wireless
  apiPath?: string; radioName?: string | null; ssid?: string | null; signal?: string | null;
  txRate?: string | null; rxRate?: string | null; uptime?: string | null; band?: string | null; registeredAt?: string | null;
  // hotspot
  username?: string | null; startedAt?: string | null; durationSec?: number | null; uploadMb?: number | null; downloadMb?: number | null;
  // ppp
  service?: string | null; callerId?: string | null; profile?: string | null; encoding?: string | null;
  syncTime?: string;
}

const SOURCE_LABELS: Record<SourceKey, { ar: string; en: string }> = {
  dhcp_leases: { ar: "إيجارات DHCP", en: "DHCP Leases" },
  arp: { ar: "جدول ARP", en: "ARP Table" },
  bridge_hosts: { ar: "مضيفو الجسر", en: "Bridge Hosts" },
  wireless: { ar: "العملاء اللاسلكيين", en: "Wireless Clients" },
  hotspot_active: { ar: "جلسات Hotspot", en: "Hotspot Sessions" },
  ppp_active: { ar: "جلسات PPPoE", en: "PPPoE Sessions" },
};

export function SourceTable({ source, routerId, openDevice, onChanged }: {
  source: SourceKey;
  routerId: string; // "all" or id
  openDevice: (deviceId: string) => void;
  onChanged?: () => void;
}) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [rows, setRows] = useState<Row[]>([]);
  const [routers, setRouters] = useState<RouterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [apFilter, setApFilter] = useState("all");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ rows: Row[]; routers: RouterInfo[] }>(`/api/network?source=${source}&routerId=${routerId}&_=${Date.now()}`);
      setRows(data.rows);
      setRouters(data.routers);
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally {
      setLoading(false);
    }
  }, [source, routerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const lastSync = useMemo(() => {
    if (rows.length === 0) return null;
    const times = routers.map((r) => r.lastSyncAt).filter(Boolean) as string[];
    return times.length ? times.sort().reverse()[0] : null;
  }, [rows, routers]);

  const aps = useMemo(() => [...new Set(rows.map((r) => r.interface).filter(Boolean) as string[])], [rows]);
  const filtered = useMemo(() => {
    let out = rows;
    if (source === "wireless" && apFilter !== "all") out = out.filter((r) => r.interface === apFilter);
    if (search) {
      const s = search.toLowerCase();
      out = out.filter((r) =>
        (r.ip ?? "").toLowerCase().includes(s) || (r.mac ?? "").toLowerCase().includes(s) ||
        (r.hostname ?? "").toLowerCase().includes(s) || (r.username ?? "").toLowerCase().includes(s) ||
        (r.interface ?? "").toLowerCase().includes(s) || (r.ssid ?? "").toLowerCase().includes(s));
    }
    return out;
  }, [rows, search, apFilter, source]);

  const networkAction = async (action: string, body: Record<string, unknown>, confirm = false) => {
    setBusy(action + JSON.stringify(body).slice(0, 40));
    try {
      const res = await api<{ detail?: string }>("/api/network/action", { json: { action, routerId: body.routerId ?? rows[0]?.routerId, ...body, confirm } });
      setToast({ msg: res.detail ?? "تم التنفيذ على السيرفر", ok: true });
      await load();
      onChanged?.();
    } catch (e) {
      setToast({ msg: (e as Error).message, ok: false });
    } finally { setBusy(null); }
  };

  const findDeviceIdByMac = async (mac: string): Promise<string | null> => {
    try {
      const res = await api<{ devices: { id: string; mac: string }[] }>(`/api/devices?search=${mac}&pageSize=1`);
      return res.devices[0]?.id ?? null;
    } catch { return null; }
  };

  const exportCsv = () => {
    if (filtered.length === 0) return;
    const keys = Object.keys(filtered[0]).filter((k) => k !== "id" && k !== "routerId");
    const csv = "\uFEFF" + [keys.join(","), ...filtered.map((r) => keys.map((k) => `"${String((r as unknown as Record<string, unknown>)[k] ?? "").replace(/"/g, '""')}"`).join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${source}-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const anyRouter = routers.length > 0;
  const unreachable = routers.every((r) => r.status !== "online");

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#64748B]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("macSearch")} className="h-8 ps-7 text-[12px] bg-[#111C30] border-[#1B2946]" />
        </div>
        {source === "wireless" && aps.length > 0 && (
          <Select value={apFilter} onValueChange={setApFilter}>
            <SelectTrigger className="h-8 w-40 text-[11px] bg-[#111C30] border-[#1B2946]"><SelectValue placeholder={t("filterByAp")} /></SelectTrigger>
            <SelectContent className="bg-[#111C30] border-[#1B2946]">
              <SelectItem value="all" className="text-[11px]">{t("ap")}: {t("total")}</SelectItem>
              {aps.map((ap) => <SelectItem key={ap} value={ap} className="text-[11px]" dir="ltr">{ap}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 me-1 ${loading ? "animate-spin" : ""}`} />{t("syncNow")}
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-[11px] border-[#1B2946]" onClick={exportCsv}><Download className="w-3.5 h-3.5 me-1" />CSV</Button>
        <span className="text-[10px] text-[#64748B]">{lastSync ? `${t("lastSync")}: ${fmtDateTime(lastSync)}` : t("neverSynced")}</span>
      </div>

      {toast && (
        <Alert className={`!py-2 ${toast.ok ? "border-emerald-700/50 bg-emerald-950/30" : "border-red-800/50 bg-red-950/30"}`}>
          <AlertDescription className={`text-[12px] ${toast.ok ? "text-emerald-300" : "text-red-300"}`} dir="auto">{toast.msg}</AlertDescription>
        </Alert>
      )}

      {unreachable && anyRouter && (
        <Alert className="!py-2 border-amber-800/50 bg-amber-950/20">
          <AlertDescription className="text-[11.5px] text-amber-300" dir="auto">{t("noRouterSync")}</AlertDescription>
        </Alert>
      )}

      {/* table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
          <table className="w-full text-[11.5px]">
            <thead className="bg-[#111C30] sticky top-0 z-10">
              <tr className="text-[#8CA3C3]">
                {source === "dhcp_leases" && (<>
                  <Th>IP</Th><Th>MAC</Th><Th>{lang === "ar" ? "الاسم" : "Hostname"}</Th><Th>{t("leaseStatus")}</Th><Th>{t("dynamicLease")}</Th><Th>{t("server")}</Th><Th>{t("expiresAfter")}</Th><Th>{t("lastSync")}</Th><Th>{t("actions")}</Th>
                </>)}
                {source === "arp" && (<>
                  <Th>IP</Th><Th>MAC</Th><Th>{t("interface")}</Th><Th>{t("status")}</Th><Th>{t("dynamicLease")}</Th><Th>{t("router")}</Th><Th>{t("lastSync")}</Th><Th>{t("actions")}</Th>
                </>)}
                {source === "bridge_hosts" && (<>
                  <Th>MAC</Th><Th>{t("bridge")}</Th><Th>{t("port")}</Th><Th>{t("vlan")}</Th><Th>{lang === "ar" ? "نوع" : "Kind"}</Th><Th>{t("dynamicLease")}</Th><Th>{t("router")}</Th><Th>{t("actions")}</Th>
                </>)}
                {source === "wireless" && (<>
                  <Th>MAC</Th><Th>{t("ap")}</Th><Th>{t("ssid")}</Th><Th>{t("signal")}</Th><Th>{t("txRate")}</Th><Th>{t("rxRate")}</Th><Th>{t("band")}</Th><Th>{t("uptime")}</Th><Th>{t("actions")}</Th>
                </>)}
                {source === "hotspot_active" && (<>
                  <Th>{t("username")}</Th><Th>IP</Th><Th>MAC</Th><Th>{t("status")}</Th><Th>{t("upload")}</Th><Th>{t("download")}</Th><Th>{t("router")}</Th><Th>{t("actions")}</Th>
                </>)}
                {source === "ppp_active" && (<>
                  <Th>{t("username")}</Th><Th>{t("ipAddress")}</Th><Th>{lang === "ar" ? "MAC المتصل" : "Caller ID"}</Th><Th>{t("package")}</Th><Th>{t("uptime")}</Th><Th>{t("router")}</Th><Th>{t("actions")}</Th>
                </>)}
              </tr>
            </thead>
            <tbody className="text-[#E2E8F0]">
              {loading && rows.length === 0 && (
                <tr><td colSpan={9} className="text-center py-10"><Loader2 className="w-5 h-5 animate-spin text-[#1685FF] mx-auto" /></td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center py-10 text-[#64748B] text-[11px]">{t("noData")}</td></tr>
              )}
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-[#1B2946]/60 hover:bg-[#111C30]/60">
                  {source === "dhcp_leases" && (<>
                    <Td mono>{r.ip}</Td>
                    <Td mono button onClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}>{r.mac}</Td>
                    <Td>{r.hostname ?? "—"}</Td>
                    <Td><LeaseStatusBadge status={r.status ?? "unknown"} /></Td>
                    <Td>{r.dynamic ? <Badge variant="outline" className="text-[9px] border-[#1B2946] text-[#8CA3C3]">{t("dynamicLease")}</Badge> : <Badge className="text-[9px] bg-[#1685FF] text-white">{t("staticLease")}</Badge>}</Td>
                    <Td mono>{r.server ?? "—"}</Td>
                    <Td mono>{r.expiresAt ? fmtDateTime(r.expiresAt) : "—"}</Td>
                    <Td>{r.lastSeen ? fmtDateTime(r.lastSeen) : "—"}</Td>
                    <Td>
                      <RowActions
                        deviceLabel={t("deviceProfile")}
                        items={[
                          { label: t("makeStatic"), run: () => networkAction("lease_make_static", { routerId: r.routerId, mac: r.mac }) },
                          { label: r.disabled ? t("enableLease") : t("disableLease"), run: () => networkAction(r.disabled ? "lease_enable" : "lease_disable", { routerId: r.routerId, mac: r.mac }) },
                          { label: t("reserveIp"), run: () => networkAction("lease_make_static", { routerId: r.routerId, mac: r.mac }) },
                          { label: t("removeLease"), danger: true, run: () => setConfirmDialog({
                              title: t("removeLease"), body: `${r.ip} ↔ ${r.mac}`,
                              run: () => networkAction("lease_remove", { routerId: r.routerId, mac: r.mac }, true),
                          }) },
                        ]}
                        onDeviceClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}
                      />
                    </Td>
                  </>)}
                  {source === "arp" && (<>
                    <Td mono>{r.ip}</Td>
                    <Td mono button onClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}>{r.mac}</Td>
                    <Td mono>{r.interface ?? "—"}</Td>
                    <Td><ArpStateBadge state={r.state ?? "incomplete"} /></Td>
                    <Td>{r.dynamic ? t("dynamicLease") : t("staticLease")}</Td>
                    <Td>{r.router}</Td>
                    <Td>{r.syncTime ? fmtDateTime(r.syncTime) : "—"}</Td>
                    <Td><RowActions deviceLabel={t("deviceProfile")} items={[{ label: t("device"), run: async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); } }]} /></Td>
                  </>)}
                  {source === "bridge_hosts" && (<>
                    <Td mono button onClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}>{r.mac}</Td>
                    <Td mono>{r.bridge ?? "—"}</Td>
                    <Td mono>{r.interface ?? "—"}</Td>
                    <Td mono>{r.vlan ?? "—"}</Td>
                    <Td>{r.isLocal ? <Badge className="text-[9px] bg-[#F59E0B] text-black">{t("localEntry")}</Badge> : t("remoteEntry")}</Td>
                    <Td>{r.dynamic ? t("dynamicLease") : t("staticLease")}</Td>
                    <Td>{r.router}</Td>
                    <Td><RowActions deviceLabel={t("deviceProfile")} items={[{ label: t("device"), run: async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); } }]} /></Td>
                  </>)}
                  {source === "wireless" && (<>
                    <Td mono button onClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}>{r.mac}</Td>
                    <Td mono><span className="inline-flex items-center gap-1"><Wifi className="w-3 h-3 text-[#22D3EE]" />{r.interface ?? "—"}</span></Td>
                    <Td mono>{r.ssid ?? "—"}</Td>
                    <Td mono>{r.signal ?? "—"}</Td>
                    <Td mono>{r.txRate ?? "—"}</Td>
                    <Td mono>{r.rxRate ?? "—"}</Td>
                    <Td mono>{r.band ?? "—"}</Td>
                    <Td mono>{r.uptime ?? "—"}</Td>
                    <Td>
                      <RowActions
                        deviceLabel={t("deviceProfile")}
                        items={[
                          { label: t("disconnectSession"), danger: true, run: () => setConfirmDialog({
                              title: t("disconnectSession"), body: `${r.mac} @ ${r.interface}`,
                              run: async () => { setToast({ msg: lang === "ar" ? "فصل العميل اللاسلكي يتم عبر قائمة الوصول — استخدم الحجب من ملف الجهاز" : "Wireless kicks are done via access-list — use Block from the device profile", ok: true }); },
                          }) },
                          { label: t("device"), run: async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); } },
                        ]}
                      />
                    </Td>
                  </>)}
                  {source === "hotspot_active" && (<>
                    <Td mono>{r.username ?? "—"}</Td>
                    <Td mono>{r.ip}</Td>
                    <Td mono button onClick={async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); }}>{r.mac}</Td>
                    <Td><LeaseStatusBadge status={r.status ?? "unknown"} /></Td>
                    <Td mono>{r.uploadMb != null ? `${(r.uploadMb / 1048576).toFixed(1)} MB` : "—"}</Td>
                    <Td mono>{r.downloadMb != null ? `${(r.downloadMb / 1048576).toFixed(1)} MB` : "—"}</Td>
                    <Td>{r.router}</Td>
                    <Td>
                      <RowActions
                        deviceLabel={t("deviceProfile")}
                        items={[
                          { label: t("disconnectSession"), danger: true, run: () => setConfirmDialog({
                              title: t("disconnectSession"), body: `${r.username ?? r.mac}`,
                              run: () => networkAction("hotspot_disconnect", { routerId: r.routerId, mac: r.mac, username: r.username }, true),
                          }) },
                          { label: t("device"), run: async () => { const id = await findDeviceIdByMac(r.mac ?? ""); if (id) openDevice(id); } },
                        ]}
                      />
                    </Td>
                  </>)}
                  {source === "ppp_active" && (<>
                    <Td mono>{r.username}</Td>
                    <Td mono>{r.ip ?? "—"}</Td>
                    <Td mono>{r.callerId ?? "—"}</Td>
                    <Td>{r.profile ?? "—"}</Td>
                    <Td mono>{r.uptime ?? "—"}</Td>
                    <Td>{r.router}</Td>
                    <Td>
                      <RowActions
                        deviceLabel={t("deviceProfile")}
                        items={[
                          { label: t("disconnectSession"), danger: true, run: () => setConfirmDialog({
                              title: t("disconnectSession"), body: r.username ?? "",
                              run: () => networkAction("ppp_disconnect", { routerId: r.routerId, username: r.username }, true),
                          }) },
                          { label: t("device"), run: async () => { const id = await findDeviceIdByMac(r.callerId ?? ""); if (id) openDevice(id); } },
                        ]}
                      />
                    </Td>
                  </>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bg-[#111C30] px-3 py-1.5 text-[10px] text-[#64748B]">{filtered.length} {lang === "ar" ? "صف" : "rows"}</div>
      </div>

      {/* confirm dialog */}
      <Dialog open={confirmDialog !== null} onOpenChange={(o) => !o && setConfirmDialog(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#1B2946] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-[14px]">{confirmDialog?.title}</DialogTitle></DialogHeader>
          <p className="text-[12px] text-[#8CA3C3]" dir="auto">{confirmDialog?.body}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-8 text-[11px] border-[#1B2946]" onClick={() => setConfirmDialog(null)}>{t("cancel")}</Button>
            <Button size="sm" className="h-8 text-[11px] bg-red-600 hover:bg-red-500" onClick={async () => { const run = confirmDialog?.run; setConfirmDialog(null); await run?.(); }}>{t("confirm")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-start px-2.5 py-2 font-bold text-[10.5px] whitespace-nowrap">{children}</th>;
}
function Td({ children, mono, button, onClick }: { children?: React.ReactNode; mono?: boolean; button?: boolean; onClick?: () => void }) {
  return (
    <td className="px-2.5 py-1.5 whitespace-nowrap">
      {button ? (
        <button onClick={onClick} className="text-[#22D3EE] hover:underline num" dir="ltr">{children}</button>
      ) : (
        <span className={mono ? "num" : ""} dir={mono ? "ltr" : "auto"}>{children}</span>
      )}
    </td>
  );
}
function RowActions({ items, onDeviceClick, deviceLabel }: {
  items: { label: string; danger?: boolean; run: () => void | Promise<void> }[];
  onDeviceClick?: () => void;
  deviceLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-[#8CA3C3]" aria-label="actions"><MoreVertical className="w-3.5 h-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-[#111C30] border-[#1B2946] text-[11px]">
        {onDeviceClick && <DropdownMenuItem onClick={onDeviceClick}>{deviceLabel ?? "Profile"}</DropdownMenuItem>}
        {items.map((it, i) => (
          <DropdownMenuItem key={i} onClick={() => void it.run()} className={it.danger ? "text-red-400" : ""}>{it.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LeaseStatusBadge({ status }: { status: string }) {
  const cls =
    status === "bound" ? "bg-emerald-600 text-white" :
    status === "waiting" ? "bg-sky-600 text-white" :
    status === "offered" ? "bg-blue-600 text-white" :
    status === "declined" ? "bg-orange-600 text-white" :
    "bg-slate-600 text-white";
  return <Badge className={`text-[9px] ${cls}`} dir="ltr">{status}</Badge>;
}

function ArpStateBadge({ state }: { state: string }) {
  const cls =
    state === "complete" ? "bg-emerald-600 text-white" :
    state === "invalid" ? "bg-red-600 text-white" :
    "bg-slate-600 text-white";
  return <Badge className={`text-[9px] ${cls}`} dir="ltr">{state}</Badge>;
}
