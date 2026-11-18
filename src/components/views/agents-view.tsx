"use client";

import { useCallback, useEffect, useState } from "react";
import { api, useApp } from "@/lib/store";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { DlgField } from "./packages-view";
import {
  RadioTower, Plus, Loader2, Copy, ShieldAlert, RefreshCw, Trash2,
  TerminalSquare, CheckCircle2, Clock, Wifi, WifiOff,
} from "lucide-react";

interface AgentCap { name?: string; host?: string; port?: number }
interface AgentRow {
  id: string;
  name: string;
  version: string;
  status: string;
  remoteIp: string | null;
  capabilities: AgentCap[];
  branch: string | null;
  router: string | null;
  lastSeenAt: string | null;
  online: boolean;
  uptimeSec: number | null;
}
interface EnrollResult { ok: boolean; code: string; hint: string; command: string; platformUrl: string; note: string }

// Build the install command from the BROWSER origin so the copied command is
// always valid for exactly the URL the operator is using — immune to any
// proxy header rewriting on the server side.
function withBrowserOrigin(res: EnrollResult): EnrollResult {
  try {
    const origin = window.location.origin;
    if (origin && /^https?:\/\//.test(origin)) {
      return {
        ...res,
        command: `curl -fsSL "${origin}/api/agents/bootstrap?code=${res.code}" | bash`,
        platformUrl: origin,
      };
    }
  } catch { /* SSR / no window — keep server-provided command */ }
  return res;
}

function fmtAgo(iso: string | null, ar: boolean): string {
  if (!iso) return ar ? "لم يتصل بعد" : "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return ar ? "الآن" : "just now";
  if (s < 3600) return ar ? `قبل ${Math.floor(s / 60)} د` : `${Math.floor(s / 60)}m ago`;
  return ar ? `قبل ${Math.floor(s / 3600)} س` : `${Math.floor(s / 3600)}h ago`;
}

function CopyLine({ text, label }: { text: string; label?: string }) {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      {label && <div className="text-[11px] font-bold text-[#8CA3C3]">{label}</div>}
      <div className="flex items-stretch gap-1.5">
        <pre dir="ltr" className="flex-1 min-w-0 bg-[#060D1B] border border-[#24344F] rounded-lg px-2.5 py-2 text-[11px] text-[#7DD3FC] overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-[#22D3EE] hover:text-[#67E8F9] hover:bg-[#0B1428]"
          aria-label="copy"
          onClick={async () => {
            try { await navigator.clipboard.writeText(text); } catch {
              const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
              document.execCommand("copy"); document.body.removeChild(ta);
            }
            setCopied(true); toast.success(ar ? "تم النسخ" : "Copied");
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

export function AgentsView() {
  const lang = useApp((s) => s.lang);
  const ar = lang === "ar";
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [enroll, setEnroll] = useState<{ agent: AgentRow; res: EnrollResult } | null>(null);

  const load = useCallback(() => {
    api<{ agents: AgentRow[] }>("/api/agents")
      .then((d) => setAgents(d.agents))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function genCode(a: AgentRow) {
    setBusy(a.id);
    try {
      const res = withBrowserOrigin(await api<EnrollResult>("/api/agents/enroll-code", { method: "POST", json: { agentId: a.id } }));
      setEnroll({ agent: a, res });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  async function addAgent() {
    setBusy("add");
    try {
      const d = await api<{ agent: { id: string; name: string } }>("/api/agents", { method: "POST", json: { name: name.trim() || "agent" } });
      toast.success(ar ? "تم إنشاء الوكيل — توليد كود التثبيت..." : "Agent created — generating install code...");
      setAddOpen(false); setName("");
      load();
      // chain straight into the enroll-code flow for the new agent
      const res = withBrowserOrigin(await api<EnrollResult>("/api/agents/enroll-code", { method: "POST", json: { agentId: d.agent.id } }));
      setEnroll({ agent: { id: d.agent.id, name: d.agent.name, version: "1.0.0", status: "offline", remoteIp: null, capabilities: [], branch: null, router: null, lastSeenAt: null, online: false, uptimeSec: null }, res });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  async function revoke(a: AgentRow) {
    if (!window.confirm(ar ? `إبطال وحذف الوكيل "${a.name}"؟ سيفشل اتصاله نهائياً.` : `Revoke agent "${a.name}"?`)) return;
    setBusy(a.id);
    try {
      await api(`/api/agents?id=${a.id}`, { method: "DELETE" });
      toast.success(ar ? "تم الإبطال" : "Revoked");
      load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-extrabold text-white flex items-center gap-2">
          <RadioTower className="w-5 h-5 text-[#22D3EE]" />
          {ar ? "وكلاء الشبكة — إضافة السيرفرات عن بُعد" : "Network Agents — Remote Server Onboarding"}
        </h1>
        <Button onClick={() => setAddOpen(true)} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-xs gap-1.5">
          <Plus className="w-4 h-4" /> {ar ? "إضافة سيرفر (وكيل جديد)" : "Add server (new agent)"}
        </Button>
      </div>

      <div className="panel p-3.5 border-r-2 border-r-[#F59E0B]" style={{ borderRightWidth: 2 }}>
        <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[#CBD5E1]">
          <ShieldAlert className="w-4 h-4 text-[#F59E0B] shrink-0 mt-0.5" />
          <div>
            <b className="text-white">{ar ? "طريقة الربط: " : "How it works: "}</b>
            {ar
              ? "اضغط «توليد كود التثبيت» ثم انسخ الأمر والصقه في طرفية Linux بجوار السيرفر — سيتصل الـ Agent تلقائياً ويكتشف أجهزة الشبكة."
              : "Click “Generate install code”, copy the command and paste it in a Linux terminal next to the server — the agent connects automatically."}
            <div className="mt-1 text-[#F59E0B] font-bold">
              {ar ? "⛔ لا تنفّذ الأمر داخل طرفية MikroTik/RouterOS أبداً (سيفشل بـ bad command name) — يجب أن يكون طرفية Linux حقيقية."
                  : "⛔ Never paste it inside a MikroTik/RouterOS terminal — it must be a real Linux shell."}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          <Skeleton className="h-40 rounded-xl bg-[#111C33]" />
          <Skeleton className="h-40 rounded-xl bg-[#111C33]" />
        </div>
      ) : agents.length === 0 ? (
        <div className="panel p-6 text-center text-xs text-[#64748B]">
          {ar ? "لا يوجد وكلاء بعد — اضغط «إضافة سيرفر» لإنشاء أول وكيل وتوليد كود التثبيت" : "No agents yet"}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {agents.map((a) => (
            <div key={a.id} className="panel p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-extrabold text-white truncate" dir="ltr">{a.name}</div>
                  <div className="text-[10px] text-[#8CA3C3] num" dir="ltr">v{a.version}{a.remoteIp ? ` · ${a.remoteIp}` : ""}</div>
                </div>
                <span className={`flex items-center gap-1 text-[10px] font-bold ${a.online ? "text-emerald-400" : "text-[#64748B]"}`}>
                  {a.online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                  {a.online ? (ar ? "متصل" : "online") : (ar ? "غير متصل" : "offline")}
                </span>
              </div>

              <div className="flex items-center gap-1.5 text-[10px] text-[#8CA3C3]">
                <Clock className="w-3 h-3" />
                {ar ? "آخر ظهور" : "last seen"}: {fmtAgo(a.lastSeenAt, ar)}
                {a.uptimeSec != null && <span className="num" dir="ltr">· {Math.floor(a.uptimeSec / 3600)}h{Math.floor((a.uptimeSec % 3600) / 60)}m</span>}
              </div>

              {a.capabilities?.length > 0 && (
                <div className="space-y-1">
                  {a.capabilities.slice(0, 3).map((c, i) => (
                    <div key={i} className="text-[10px] bg-[#0B1428] border border-[#1B2946]/70 rounded px-2 py-1 text-[#94A9C9] truncate" dir="ltr">
                      {c.name ?? "router"}{c.host ? ` (${c.host})` : ""}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5 pt-1">
                <Button onClick={() => genCode(a)} disabled={busy === a.id} className="flex-1 bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold text-[11px] gap-1.5">
                  {busy === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TerminalSquare className="w-3.5 h-3.5" />}
                  {ar ? "توليد كود التثبيت" : "Generate install code"}
                </Button>
                <Button onClick={() => genCode(a)} variant="ghost" size="icon" aria-label="refresh" className="text-[#8CA3C3] hover:text-[#CBD5E1]">
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
                <Button onClick={() => revoke(a)} variant="ghost" size="icon" aria-label="revoke" className="text-[#EF4444]/80 hover:text-[#EF4444]">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* add agent dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-sm">
          <DialogHeader><DialogTitle className="text-white">{ar ? "إضافة سيرفر — وكيل جديد" : "Add server — new agent"}</DialogTitle></DialogHeader>
          <DlgField label={ar ? "اسم الوكيل (مثل: فرع-القاهرة)" : "Agent name (e.g. cairo-branch)"} value={name} onChange={setName} dir="ltr" />
          <div className="text-[10px] text-[#64748B]">
            {ar ? "بعد الإنشاء سيُولَّد كود التثبيت تلقائياً وتظهر أمر التثبيت الجاهز للنسخ." : "After creation the install code is generated and the ready command is shown."}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setAddOpen(false)} className="text-[#CBD5E1]">{ar ? "إلغاء" : "Cancel"}</Button>
            <Button onClick={addAgent} disabled={busy === "add"} className="bg-[#1685FF] hover:bg-[#3B97FF] text-white font-bold">
              {busy === "add" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (ar ? "إنشاء وتوليد الكود" : "Create & generate code")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* enroll code dialog */}
      <Dialog open={!!enroll} onOpenChange={(o) => !o && setEnroll(null)}>
        <DialogContent className="bg-[#0E1A31] border-[#24344F] text-[#F1F5F9] max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-white">{ar ? "كود تثبيت السيرفر" : "Server install code"} — <span dir="ltr">{enroll?.agent.name}</span></DialogTitle>
          </DialogHeader>
          {enroll && (
            <div className="space-y-3">
              <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/40 rounded-lg p-2.5 text-[11px] font-bold text-[#FBBF24] flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                {ar ? "نفّذ هذا الأمر في طرفية Linux (SSH لسيرفر Ubuntu بجوار الراوتر أو نفس سيرفر المنصة) — وليس داخل طرفية MikroTik."
                    : "Run this in a Linux terminal next to the router — never inside MikroTik/RouterOS."}
              </div>
              <CopyLine label={ar ? "الأمر الجاهز (انسخه كما هو)" : "Ready command (copy as-is)"} text={enroll.res.command} />
              <CopyLine label={ar ? "الكود (يظهر مرة واحدة)" : "Code (shown once)"} text={enroll.res.code} />
              <div className="text-[10.5px] text-[#8CA3C3] leading-relaxed space-y-1">
                <div>{ar ? "1) افتح طرفية Linux في شبكة السيرفر المراد إدارته." : "1) Open a Linux shell in the target server's network."}</div>
                <div>{ar ? "2) الصق الأمر واضغط Enter — سيُثبَّت الـ Agent كخدمة systemd وتعمل تلقائياً." : "2) Paste and press Enter — the agent installs as a systemd service."}</div>
                <div>{ar ? "3) خلال ثوانٍ سيتحول هذا الوكيل إلى «متصل» هنا ويبدأ اكتشاف أجهزة الشبكة." : "3) Within seconds the agent turns “online” here and starts discovering devices."}</div>
                <div className="text-[#F59E0B]">{ar ? "ملاحظة: توليد كود جديد يُبطل هذا الكود فوراً." : "Note: generating a new code invalidates this one."}</div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
