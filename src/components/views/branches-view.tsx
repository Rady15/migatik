"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp, fmtNum } from "@/lib/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { DlgField } from "./packages-view";
import { Building2, Plus, Loader2 } from "lucide-react";

interface Org { id: string; name: string; code: string; active: boolean }
interface Branch { id: string; name: string; code: string; phone: string | null; address: string | null; organizationId: string | null; organization?: { name: string; code: string } | null }
interface Counts { id: string; routers: number; subscribers: number; employees: number; agents: number }
interface RouterRow { id: string; name: string; branchId: string | null }

export function BranchesView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [counts, setCounts] = useState<Counts[]>([]);
  const [routers, setRouters] = useState<RouterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [orgOpen, setOrgOpen] = useState(false);
  const [brOpen, setBrOpen] = useState(false);
  const [orgForm, setOrgForm] = useState({ name: "", code: "" });
  const [brForm, setBrForm] = useState({ name: "", code: "", organizationId: "", phone: "", address: "" });

  const load = useCallback(() => {
    setLoading(true);
    api<{ organizations: Org[]; branches: Branch[]; counts: Counts[] }>("/api/branches")
      .then((d) => { setOrgs(d.organizations); setBranches(d.branches); setCounts(d.counts); })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
    api<{ routers: RouterRow[] }>("/api/routers").then((d) => setRouters(d.routers)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createOrg() {
    setBusy("org");
    try {
      await api("/api/branches", { method: "POST", json: { type: "organization", ...orgForm, code: orgForm.code || orgForm.name.toUpperCase().replace(/\s+/g, "-") } });
      toast.success(ar ? "تم إنشاء المنظمة" : "Organization created");
      setOrgOpen(false);
      setOrgForm({ name: "", code: "" });
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  async function createBranch() {
    setBusy("branch");
    try {
      await api("/api/branches", { method: "POST", json: { ...brForm, code: brForm.code || brForm.name.toUpperCase().replace(/\s+/g, "-") } });
      toast.success(ar ? "تم إنشاء الفرع" : "Branch created");
      setBrOpen(false);
      setBrForm({ name: "", code: "", organizationId: "", phone: "", address: "" });
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  async function assign(routerId: string, branchId: string | null) {
    setBusy(routerId);
    try {
      await api("/api/branches", { method: "PATCH", json: { routerIds: [routerId], branchId } });
      toast.success(ar ? "تم تعيين الفرع" : "Assigned");
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white flex items-center gap-2"><Building2 className="w-5 h-5 text-[#22D3EE]" /> {ar ? "المنظمات والفروع" : "Organizations & Branches"}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => setOrgOpen(true)} variant="ghost" className="text-[#CBD5E1] text-xs gap-1.5"><Plus className="w-3.5 h-3.5" /> {ar ? "منظمة" : "Organization"}</Button>
          <Button onClick={() => setBrOpen(true)} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5"><Plus className="w-4 h-4" /> {ar ? "فرع جديد" : "New branch"}</Button>
        </div>
      </div>

      {loading ? <Skeleton className="h-64 rounded-xl bg-[#111C33]" /> : (
        <>
          {orgs.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              {orgs.map((o) => (
                <div key={o.id} className="panel p-3">
                  <div className="text-sm font-extrabold text-white">{o.name}</div>
                  <div className="text-[10px] text-[#8CA3C3] num" dir="ltr">{o.code}</div>
                  <div className="text-[10px] text-[#64748B] mt-1">{ar ? "الفروع" : "Branches"}: {branches.filter((b) => b.organizationId === o.id).length}</div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {branches.length === 0 && <div className="text-xs text-[#64748B]">{ar ? "لا فروع بعد — أنشئ أول فرع واربط السيرفرات به" : "No branches yet"}</div>}
            {branches.map((b) => {
              const c = counts.find((x) => x.id === b.id);
              return (
                <div key={b.id} className="panel p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-extrabold text-white">{b.name}</div>
                      <div className="text-[10px] text-[#8CA3C3] num" dir="ltr">{b.code}{b.organization ? ` · ${b.organization.name}` : ""}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-center">
                    {([["routers", ar ? "سيرفرات" : "Routers"], ["subscribers", ar ? "مشتركون" : "Subs"], ["employees", ar ? "موظفون" : "Staff"], ["agents", "Agents"]] as const).map(([k, label]) => (
                      <div key={k} className="bg-[#0B1428] border border-[#1B2946]/70 rounded-lg py-1.5">
                        <div className="text-xs font-extrabold text-white num" dir="ltr">{fmtNum((c as unknown as Record<string, number>)?.[k] ?? 0)}</div>
                        <div className="text-[9px] text-[#8CA3C3]">{label}</div>
                      </div>
                    ))}
                  </div>
                  {b.phone && <div className="text-[10px] text-[#8CA3C3] num" dir="ltr">{b.phone}</div>}
                </div>
              );
            })}
          </div>

          {/* router assignment */}
          <div className="panel p-4">
            <h2 className="text-sm font-extrabold text-white mb-3">{ar ? "تعيين السيرفرات للفروع" : "Assign routers to branches"}</h2>
            <div className="space-y-2">
              {routers.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 bg-[#0B1428] border border-[#1B2946]/70 rounded-lg px-3 py-2">
                  <span className="text-xs font-bold text-[#E2E8F0]">{r.name}</span>
                  <div className="flex items-center gap-2">
                    <select
                      value={r.branchId ?? ""}
                      onChange={(e) => assign(r.id, e.target.value || null)}
                      disabled={busy === r.id}
                      className="bg-[#0E1A31] border border-[#24344F] rounded-lg px-2 py-1.5 text-xs text-white"
                    >
                      <option value="">{ar ? "— بدون فرع —" : "— no branch —"}</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    {busy === r.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1685FF]" />}
                  </div>
                </div>
              ))}
              {routers.length === 0 && <div className="text-xs text-[#64748B]">—</div>}
            </div>
            <div className="text-[10px] text-[#64748B] mt-2">
              {ar ? "الموظفون والمشتركون يُعيَّنون بنفس الطريقة عبر API (userIds/subscriberIds) — عزل التقارير المالية يتم عبر فلتر الفرع في وحدة المالية" : "Employees/subscribers assign via the same API (userIds/subscriberIds) — financial reporting isolation uses the branch filter in Finance"}
            </div>
          </div>
        </>
      )}

      {/* org dialog */}
      <Dialog open={orgOpen} onOpenChange={setOrgOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-white">{ar ? "منظمة جديدة" : "New organization"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><DlgField label={ar ? "الاسم" : "Name"} value={orgForm.name} onChange={(v) => setOrgForm({ ...orgForm, name: v })} /></div>
            <div className="col-span-2"><DlgField label="Code" value={orgForm.code} onChange={(v) => setOrgForm({ ...orgForm, code: v })} dir="ltr" /></div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOrgOpen(false)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={createOrg} disabled={busy === "org"} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold">{busy === "org" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (ar ? "إنشاء" : "Create")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* branch dialog */}
      <Dialog open={brOpen} onOpenChange={setBrOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-md">
          <DialogHeader><DialogTitle className="text-white">{ar ? "فرع جديد" : "New branch"}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><DlgField label={ar ? "الاسم" : "Name"} value={brForm.name} onChange={(v) => setBrForm({ ...brForm, name: v })} /></div>
            <DlgField label="Code" value={brForm.code} onChange={(v) => setBrForm({ ...brForm, code: v })} dir="ltr" />
            <div>
              <label className="text-xs text-[#8CA3C3] mb-1 block">{ar ? "المنظمة" : "Organization"}</label>
              <select value={brForm.organizationId} onChange={(e) => setBrForm({ ...brForm, organizationId: e.target.value })} className="w-full bg-[#0B1428] border border-[#24344F] rounded-lg px-2 py-2 text-xs text-white">
                <option value="">—</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <DlgField label={ar ? "الهاتف" : "Phone"} value={brForm.phone} onChange={(v) => setBrForm({ ...brForm, phone: v })} dir="ltr" />
            <DlgField label={ar ? "العنوان" : "Address"} value={brForm.address} onChange={(v) => setBrForm({ ...brForm, address: v })} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setBrOpen(false)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={createBranch} disabled={busy === "branch"} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold">{busy === "branch" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (ar ? "إنشاء" : "Create")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
