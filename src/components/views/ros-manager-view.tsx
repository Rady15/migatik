"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp } from "@/lib/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SlidersHorizontal, Loader2, RefreshCw, Plus, ShieldAlert, Undo2, Search } from "lucide-react";

interface RouterRow { id: string; name: string; status: string; version: string | null }
interface SectionMeta {
  id: string; titleAr: string; titleEn: string;
  fields: string[]; columns: string[]; printPath: string;
  canAdd: boolean; canSet: boolean; canRemove: boolean;
}
interface RowsResp {
  ok: boolean; error?: string; unsupported?: boolean; rows: Record<string, string>[];
  section: SectionMeta; router: { name: string; status: string; version: string | null };
  fetchedAt: string;
}

/** Fallback ids in the exact order requested — the API meta supplies the real titles. */
const SECTION_IDS = [
  "dhcp_servers", "dhcp_networks", "ip_addresses", "ip_pools",
  "vlans", "bridges", "bridge_ports",
  "wireless", "wifi", "capsman", "capsman_provisions",
  "hotspot_servers", "hotspot_users", "hotspot_profiles", "hotspot_active", "hotspot_hosts", "hotspot_bindings",
  "ppp_secrets", "ppp_profiles",
  "simple_queues", "queue_trees",
  "firewall_filter", "firewall_nat", "dns", "routes", "interfaces", "services",
] as const;

/** Arabic labels for RouterOS property names (headers stay raw in the title attribute). */
const FIELD_LABELS: Record<string, { ar: string; en: string }> = {
  name: { ar: "الاسم", en: "Name" },
  interface: { ar: "الواجهة", en: "Interface" },
  "actual-interface": { ar: "الواجهة الفعلية", en: "Actual interface" },
  "address-pool": { ar: "مجموعة العناوين", en: "Address pool" },
  "lease-time": { ar: "مدة الإيجار", en: "Lease time" },
  disabled: { ar: "معطّل", en: "Disabled" },
  comment: { ar: "ملاحظة", en: "Comment" },
  address: { ar: "العنوان", en: "Address" },
  gateway: { ar: "البوابة", en: "Gateway" },
  netmask: { ar: "القناع", en: "Netmask" },
  "dns-server": { ar: "خادم DNS", en: "DNS server" },
  domain: { ar: "النطاق", en: "Domain" },
  network: { ar: "الشبكة", en: "Network" },
  ranges: { ar: "النطاقات", en: "Ranges" },
  total: { ar: "الإجمالي", en: "Total" },
  used: { ar: "المستخدم", en: "Used" },
  available: { ar: "المتاح", en: "Available" },
  "vlan-id": { ar: "معرّف VLAN", en: "VLAN ID" },
  "vlan-filtering": { ar: "فلترة VLAN", en: "VLAN filtering" },
  bridge: { ar: "الجسر", en: "Bridge" },
  pvid: { ar: "PVID", en: "PVID" },
  ssid: { ar: "SSID", en: "SSID" },
  mode: { ar: "الوضع", en: "Mode" },
  band: { ar: "النطاق", en: "Band" },
  frequency: { ar: "التردد", en: "Frequency" },
  enabled: { ar: "مفعّل", en: "Enabled" },
  certificate: { ar: "الشهادة", en: "Certificate" },
  "require-peer-certificate": { ar: "شهادة النظير", en: "Peer certificate" },
  action: { ar: "الإجراء", en: "Action" },
  "master-configuration": { ar: "الإعداد الرئيسي", en: "Master configuration" },
  profile: { ar: "البروفايل", en: "Profile" },
  uptime: { ar: "مدة الاتصال", en: "Uptime" },
  "bytes-in": { ar: "بايت داخل", en: "Bytes in" },
  "bytes-out": { ar: "بايت خارج", en: "Bytes out" },
  "rate-limit": { ar: "حد السرعة", en: "Rate limit" },
  "shared-users": { ar: "مستخدمون مشتركون", en: "Shared users" },
  "session-timeout": { ar: "مهلة الجلسة", en: "Session timeout" },
  "login-by": { ar: "الدخول بواسطة", en: "Login by" },
  "idle-timeout": { ar: "مهلة الخمول", en: "Idle timeout" },
  service: { ar: "الخدمة", en: "Service" },
  "local-address": { ar: "العنوان المحلي", en: "Local address" },
  "remote-address": { ar: "العنوان البعيد", en: "Remote address" },
  target: { ar: "الهدف", en: "Target" },
  "max-limit": { ar: "الحد الأقصى", en: "Max limit" },
  parent: { ar: "الأصل", en: "Parent" },
  "packet-mark": { ar: "علامة الحزم", en: "Packet mark" },
  priority: { ar: "الأولوية", en: "Priority" },
  chain: { ar: "السلسلة", en: "Chain" },
  protocol: { ar: "البروتوكول", en: "Protocol" },
  "src-address": { ar: "المصدر", en: "Src address" },
  "dst-address": { ar: "الوجهة", en: "Dst address" },
  "dst-port": { ar: "منفذ الوجهة", en: "Dst port" },
  "in-interface": { ar: "واجهة الدخول", en: "In interface" },
  "out-interface": { ar: "واجهة الخروج", en: "Out interface" },
  "to-addresses": { ar: "عناوين التحويل", en: "To addresses" },
  servers: { ar: "خوادم DNS", en: "DNS servers" },
  "allow-remote-requests": { ar: "السماح بالطلبات البعيدة", en: "Allow remote requests" },
  "dynamic-servers": { ar: "خوادم ديناميكية", en: "Dynamic servers" },
  distance: { ar: "المسافة", en: "Distance" },
  active: { ar: "نشط", en: "Active" },
  dynamic: { ar: "ديناميكي", en: "Dynamic" },
  type: { ar: "النوع", en: "Type" },
  mtu: { ar: "MTU", en: "MTU" },
  "mac-address": { ar: "عنوان MAC", en: "MAC address" },
  running: { ar: "يعمل", en: "Running" },
  "rx-byte": { ar: "المستقبل", en: "RX bytes" },
  "tx-byte": { ar: "المرسل", en: "TX bytes" },
  port: { ar: "المنفذ", en: "Port" },
  proto: { ar: "البروتوكول", en: "Proto" },
  "available-from": { ar: "متاح من", en: "Available from" },
};

export function RosManagerView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [routers, setRouters] = useState<RouterRow[]>([]);
  const [routerId, setRouterId] = useState("");
  const [section, setSection] = useState<string>("dhcp_servers");
  const [meta, setMeta] = useState<SectionMeta[]>([]);
  const [resp, setResp] = useState<RowsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [editRosId, setEditRosId] = useState("");
  const [op, setOp] = useState<"add" | "set">("add");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ routers: RouterRow[] }>("/api/routers").then((d) => {
      setRouters(d.routers);
      const first = d.routers.find((r) => r.status === "online") ?? d.routers[0];
      if (first) setRouterId(first.id);
    }).catch(() => {});
    // Section catalogue: real titles/columns/flags straight from the server config.
    api<{ sections: SectionMeta[] }>("/api/ros?meta=1").then((d) => setMeta(d.sections)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!routerId) return;
    setLoading(true);
    setResp(null);
    api<RowsResp>(`/api/ros?routerId=${routerId}&section=${section}&_=${Date.now()}`)
      .then((d) => setResp(d))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [routerId, section]);

  useEffect(() => { load(); }, [load]);

  // Live Hotspot menus: keep the read-only tables fresh without the loading
  // flicker (they change every time a client connects or disconnects).
  const silentLoad = useCallback(async () => {
    if (!routerId) return;
    try {
      const d = await api<RowsResp>(`/api/ros?routerId=${routerId}&section=${section}&_=${Date.now()}`);
      setResp(d);
    } catch { /* keep the last good snapshot */ }
  }, [routerId, section]);

  useEffect(() => {
    if (!section.startsWith("hotspot_")) return;
    if (!["hotspot_active", "hotspot_hosts", "hotspot_bindings"].includes(section)) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void silentLoad();
    }, 5000);
    return () => clearInterval(timer);
  }, [section, silentLoad]);

  async function submitWrite() {
    if (!resp || !editing) return;
    if (!window.confirm(ar
      ? `سيتم تنفيذ العملية على السيرفر الفعلي — راجع القيم:\n${JSON.stringify(editing, null, 2)}`
      : `This will execute on the real router — review:\n${JSON.stringify(editing, null, 2)}`)) return;
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; message?: string; warning?: string }>("/api/ros", {
        method: "POST",
        json: { routerId, section, op, rosId: op === "set" && editRosId ? editRosId : undefined, data: editing, confirm: true },
      });
      if (res.warning) toast.warning(res.warning, { duration: 8000 });
      else toast.success(res.message || (ar ? "تم التنفيذ" : "Applied"));
      setEditing(null);
      load();
    } catch (e) {
      toast.error((e as Error).message, { duration: 8000 });
    } finally { setBusy(false); }
  }

  async function removeRow(rosId: string) {
    if (!window.confirm(ar ? "حذف العنصر من السيرفر فعلياً؟" : "Remove this item from the router?")) return;
    setBusy(true);
    try {
      await api("/api/ros", { method: "POST", json: { routerId, section, op: "remove", rosId, confirm: true } });
      toast.success(ar ? "تم الحذف" : "Removed");
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function recovery() {
    if (!window.confirm(ar
      ? "استرجاع الطوارئ: حذف كل القواعد المُدارة (mtcm-managed) في هذا القسم؟ استخدم هذا إن حجبت جلسة الإدارة."
      : "Emergency recovery: remove ALL mtcm-managed rules in this section? Use if the management session was locked out.")) return;
    setBusy(true);
    try {
      const res = await api<{ recovered?: number }>("/api/ros", { method: "POST", json: { routerId, section, op: "remove", recoveryManaged: true, confirm: true } });
      toast.success(`${ar ? "حُذفت" : "Removed"} ${res.recovered ?? 0}`);
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  const title = (s: SectionMeta) => (ar ? s.titleAr : s.titleEn);
  const sectionTitle = (id: string) => {
    const m = meta.find((s) => s.id === id);
    return m ? (ar ? m.titleAr : m.titleEn) : id.replace(/_/g, " ");
  };
  const fieldLabel = (k: string) => {
    const l = FIELD_LABELS[k];
    return l ? (ar ? l.ar : l.en) : k;
  };

  /** Columns actually present in the live rows (fall back to the discovered keys). */
  const rows = resp?.rows ?? [];
  const provided = resp?.section.columns ?? [];
  const presentIn = (k: string) => rows.some((r) => r[k] !== undefined);
  const discovered = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((k) => k !== ".id");
  let cols = provided.length ? provided.filter(presentIn) : discovered.slice(0, 10);
  if (!cols.length) cols = provided.length ? provided.slice(0, 8) : discovered.slice(0, 8);

  const q = query.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) => Object.entries(r).some(([k, v]) => k !== ".id" && String(v).toLowerCase().includes(q)))
    : rows;

  const fmt = (v?: string) => {
    if (v === undefined || v === "") return "—";
    if (v === "true" || v === "yes") return ar ? "نعم" : "yes";
    if (v === "false" || v === "no") return ar ? "لا" : "no";
    return v;
  };

  function openAdd() {
    setOp("add");
    setEditRosId("");
    setEditing({});
  }
  function openEdit(row: Record<string, string>) {
    if (!resp) return;
    setOp("set");
    setEditRosId(row[".id"] ?? "");
    const vals: Record<string, string> = {};
    for (const f of resp.section.fields) if (row[f] !== undefined) vals[f] = row[f];
    setEditing(vals);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white flex items-center gap-2"><SlidersHorizontal className="w-5 h-5 text-[#22D3EE]" /> {ar ? "مدير RouterOS — قراءة حية وكتابة آمنة" : "RouterOS Manager — live read, safe writes"}</h1>
        <div className="flex items-center gap-2">
          <select value={routerId} onChange={(e) => setRouterId(e.target.value)} className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-3 py-2 text-xs text-white max-w-[200px]">
            {routers.map((r) => <option key={r.id} value={r.id}>{r.name} {r.status !== "online" ? (ar ? "(غير متصل)" : "(offline)") : ""}</option>)}
          </select>
          <Button onClick={load} variant="ghost" className="text-[#CBD5E1] text-xs gap-1.5"><RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> {ar ? "تحديث حي" : "Live refresh"}</Button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {SECTION_IDS.map((s) => (
          <button
            key={s}
            onClick={() => { setSection(s); setQuery(""); }}
            title={meta.find((m) => m.id === s)?.titleEn ?? s}
            className={`text-[11px] font-bold rounded-lg px-2.5 py-1.5 border ${section === s ? "bg-[#1685FF] border-[#1685FF] text-white" : "bg-[#0B1428] border-[#24344F] text-[#CBD5E1]"}`}
          >
            {sectionTitle(s)}
          </button>
        ))}
      </div>

      {!routerId ? (
        <div className="text-xs text-[#64748B] py-8 text-center">{ar ? "أضف سيرفراً أولاً" : "Add a router first"}</div>
      ) : loading ? (
        <Skeleton className="h-72 rounded-xl bg-[#111C33]" />
      ) : resp && !resp.ok ? (
        <div className="panel p-6 text-center space-y-2">
          <div className={`text-xs font-bold ${resp.unsupported ? "text-amber-300" : "text-red-300"}`}>
            {resp.unsupported ? (ar ? "غير مدعوم على هذا الإصدار من RouterOS — نتيجة متوقعة وليست خطأ" : "Unsupported on this RouterOS version — expected, not an error") : resp.error}
          </div>
          <div className="text-[10px] text-[#64748B]" dir="ltr">{resp.router?.name} · RouterOS {resp.router?.version ?? "?"} · {resp.section?.printPath}</div>
          <div className="text-[10px] text-[#64748B]">{ar ? "لا يتم عرض أي بيانات وهمية — القراءة الحية فقط." : "No simulated data is ever shown — live read only."}</div>
        </div>
      ) : resp ? (
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-3 border-b border-[#1B2946]">
            <div>
              <span className="text-sm font-extrabold text-white">{title(resp.section)}</span>
              <span className="text-[10px] text-[#64748B] num ms-2" dir="ltr">{visible.length}/{resp.rows.length} rows · {resp.fetchedAt.slice(11, 19)} · {resp.router?.version ?? "?"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#5B7194] absolute top-1/2 -translate-y-1/2 start-2 pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={ar ? "تصفية الصفوف..." : "Filter rows..."}
                  className="w-40 bg-[#0B1428] border border-[#24344F] rounded-lg ps-7 pe-2 py-1.5 text-[11px] text-white outline-none focus:border-[#1685FF]"
                />
              </div>
              {["firewall_filter", "firewall_nat"].includes(section) && resp.section.canRemove && (
                <Button size="sm" onClick={recovery} disabled={busy} className="bg-red-900/60 hover:bg-red-800 text-red-200 text-[10px] gap-1"><Undo2 className="w-3 h-3" /> {ar ? "استرجاع القواعد المُدارة" : "Recovery: remove managed"}</Button>
              )}
              {resp.section.canAdd && (
                <Button size="sm" onClick={openAdd} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white text-[10px] gap-1"><Plus className="w-3 h-3" /> {ar ? "إضافة" : "Add"}</Button>
              )}
            </div>
          </div>
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="mt-table w-full min-w-[720px]">
              <thead>
                <tr>
                  {cols.map((k) => <th key={k} title={k}>{fieldLabel(k)}</th>)}
                  <th>.id</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && <tr><td colSpan={cols.length + 2} className="text-center text-[#64748B] py-8">{rows.length === 0 ? (ar ? "لا عناصر — الجدول فارغ على السيرفر نفسه" : "Empty table on the router itself") : (ar ? "لا صفوف مطابقة للتصفية" : "No rows match the filter")}</td></tr>}
                {visible.slice(0, 300).map((r, idx) => (
                  <tr key={r[".id"] ?? `row-${idx}`} className={`hover:bg-[#121E38]/70 ${r.disabled === "true" ? "opacity-55" : ""}`}>
                    {cols.map((k) => (
                      <td key={k} className="num text-[#CBD5E1] max-w-[240px] truncate" dir="ltr" title={r[k]}>{fmt(r[k])}</td>
                    ))}
                    <td className="num text-[9px] text-[#4C5F80]" dir="ltr">{r[".id"] ?? "—"}</td>
                    <td>
                      <div className="flex gap-1">
                        {resp.section.canSet && (
                          <button onClick={() => openEdit(r)} className="text-[10px] text-[#1685FF] hover:text-[#5CA9FF] font-bold">{ar ? "تعديل" : "Edit"}</button>
                        )}
                        {resp.section.canRemove && r[".id"] && r.default !== "true" && r.dynamic !== "true" && (
                          <button onClick={() => removeRow(r[".id"])} className="text-[10px] text-red-300 hover:text-red-200 font-bold">{ar ? "حذف" : "Del"}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-[#1B2946] text-[9.5px] text-[#4C5F80] flex items-center justify-between gap-2 flex-wrap" dir="ltr">
            <span>{resp.section.printPath} · {resp.rows.length} live rows</span>
            <span>{ar ? "قراءة مباشرة من السيرفر — بدون بيانات تجريبية" : "Read live from the router — no simulated data"}</span>
          </div>
        </div>
      ) : null}

      {/* write dialog with preview + confirm */}
      {editing && resp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="bg-[#0E1A31] border border-[#24344F] rounded-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-5 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-300" />
              <h3 className="text-sm font-extrabold text-white">{op === "add" ? (ar ? `إضافة إلى ${title(resp.section)}` : `Add to ${title(resp.section)}`) : (ar ? `تعديل ${resp.section.titleAr}${editRosId ? ` — ${editRosId}` : ""}` : `Edit ${resp.section.titleEn}${editRosId ? ` — ${editRosId}` : ""}`)}</h3>
            </div>
            <div className="text-[10px] text-[#8CA3C3] leading-relaxed">
              {ar
                ? "الأوامر مقيّدة بقائمة مسارات وحقول مسموحة لكل قسم — عمليات الكتابة تحتاج تأكيدك، وقواعد chain=input الإقصائية تتطلب إقراراً إضافياً وتوسم mtcm-managed لاسترجاعها."
                : "Commands are restricted to per-section whitelisted paths/fields; writes need your confirmation; restrictive chain=input rules need an extra acknowledgement and are tagged mtcm-managed for recovery."}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {resp.section.fields.map((f) => (
                <div key={f} className={f === "comment" ? "col-span-2" : ""}>
                  <label className="text-[10px] text-[#8CA3C3] mb-1 block" dir="ltr" title={f}>{f} · {fieldLabel(f)}</label>
                  <input
                    value={editing[f] ?? ""}
                    onChange={(e) => setEditing({ ...editing, [f]: e.target.value })}
                    className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-[#1685FF]"
                    dir="ltr"
                    placeholder={f === "chain" ? "forward" : f === "action" ? "accept|drop" : ""}
                  />
                </div>
              ))}
            </div>
            <div className="bg-[#0B1428] border border-[#24344F]/60 rounded-lg p-2 text-[10px] text-[#8CA3C3]" dir="ltr">
              {op === "add" ? `${resp.section.printPath.replace("/print", "/add")}` : `${resp.section.printPath.replace("/print", "/set")}${editRosId ? ` .id=${editRosId}` : ""}`}
              {Object.entries(editing).filter(([, v]) => v !== "").map(([k, v]) => ` ${k}=${v}`)}
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setEditing(null)} className="text-[#CBD5E1] text-xs">{ar ? "إلغاء" : "Cancel"}</Button>
              <Button onClick={submitWrite} disabled={busy} className="bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs gap-2">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                {ar ? "تطبيق على السيرفر (تأكيد)" : "Apply to router (confirm)"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
