import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterRow } from "@/lib/router-transport";
import { runCommand } from "@/lib/routeros";
import { importRouterHotspotUsers } from "@/lib/hotspot-user-sync";
import { formatLimitUptime } from "@/lib/voucher-actions";

// Avoid a new RouterOS connection on every keystroke / page change. Re-sync at
// most once per 15s per (org, router scope); `?sync=1` forces a fresh pull.
const lastImportAt = new Map<string, number>();

// GET /api/hotspot-users?search=&status=&routerId=&page=&pageSize=
export const GET = withOrg(async (req: NextRequest, ctx: OrgContext) => {
  try {
    const sp = req.nextUrl.searchParams;
    const search = sp.get("search")?.trim();
    const status = sp.get("status");
    const routerId = sp.get("routerId");
    const page = Math.max(1, Number(sp.get("page") || 1));
    const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize") || 10)));

    // Reconcile users that were created directly on the router (WebFig / CLI)
    // into the DB so they appear in the list with real, actionable ids.
    // Never let a router read failure blank out the page — DB rows still render.
    const scope = `${ctx.effectiveOrgId ?? "global"}:${routerId ?? "all"}`;
    const now = Date.now();
    if (sp.get("sync") === "1" || now - (lastImportAt.get(scope) ?? 0) > 15000) {
      lastImportAt.set(scope, now);
      await importRouterHotspotUsers(routerId && routerId !== "all" ? [routerId] : undefined).catch(() => {});
    }

    // Load all (org-scoped by db.ts) and match case-insensitively: RouterOS
    // reports MAC logins in UPPERCASE while app-created users may be lowercase.
    const allUsers = await db.hotspotUser.findMany({
      include: { package: { select: { name: true, downloadMbps: true } }, router: { select: { name: true } } },
    });

    let matched = allUsers;
    if (status && status !== "all") matched = matched.filter((u) => u.status === status);
    if (routerId && routerId !== "all") matched = matched.filter((u) => u.routerId === routerId);
    if (search) {
      const q = search.toLowerCase();
      matched = matched.filter((u) =>
        (u.username ?? "").toLowerCase().includes(q) ||
        (u.fullName ?? "").toLowerCase().includes(q) ||
        (u.phone ?? "").toLowerCase().includes(q),
      );
    }

    matched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = matched.length;
    const users = matched.slice((page - 1) * pageSize, page * pageSize);
    return NextResponse.json({
      total,
      page,
      pageSize,
      users: users.map((u) => ({
        id: u.id, username: u.username, password: u.password, fullName: u.fullName, phone: u.phone,
        status: u.status, dataUsedMb: u.dataUsedMb, uptimeSec: u.uptimeSec,
        expiresAt: u.expiresAt, createdAt: u.createdAt, routerSynced: u.routerSynced,
        routerId: u.routerId, profile: u.profile, packageId: u.packageId,
        packageName: u.package?.name ?? (u.profile && u.profile !== "default" ? u.profile : "—"), speed: u.package?.downloadMbps ?? null,
        routerName: u.router?.name ?? "—",
      })),
    });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    if (!b.username || !b.password) return NextResponse.json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }, { status: 400 });
    const exists = await db.hotspotUser.findFirst({ where: { username: String(b.username) } });
    if (exists) return NextResponse.json({ error: "اسم المستخدم موجود بالفعل" }, { status: 409 });
    let selectedPkg: any = null;
    if (b.packageId) {
      selectedPkg = await db.package.findFirst({ where: { id: String(b.packageId) } });
      if (!selectedPkg) return NextResponse.json({ error: "الباقة غير موجودة" }, { status: 400 });
    }
    // Resolve the target router (explicit id, else the first real managed router).
    const router = b.routerId
      ? await db.router.findFirst({ where: { id: String(b.routerId) } })
      : await db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 400 });

    const username = String(b.username);
    const password = String(b.password);
    // The Users dialog selects a Package, not a raw profile name. Resolve the
    // real RouterOS profile from that package so the router gets the same plan.
    let profile = b.profile ? String(b.profile) : "";
    if (!profile && selectedPkg) {
      profile = (selectedPkg.profile || selectedPkg.name || "").trim();
    }
    if (!profile) profile = "default";
    const suspended = b.status === "suspended";
    const limitUptime = formatLimitUptime(selectedPkg?.durationHours);
    const limitBytesTotal = selectedPkg?.dataLimitMb ? Number(selectedPkg.dataLimitMb) * 1024 * 1024 : 0;

    // ---- REAL router sync: create /ip/hotspot/user on the device --------
    // Do this FIRST so we never record a user in the DB that does not exist on
    // the router (which is what made WebFig show nothing).
    let routerSynced = false;
    let syncError: string | undefined;
    const sync = await withRouterRow(router, async (conn) => {
      const cmd = [
        "/ip/hotspot/user/add",
        `=name=${username}`,
        `=password=${password}`,
        `=profile=${profile}`,
        `=comment=mcm:${ctx.username}`,
      ];
      if (suspended) cmd.push("=disabled=yes");
      if (limitUptime) cmd.push(`=limit-uptime=${limitUptime}`);
      if (limitBytesTotal > 0) cmd.push(`=limit-bytes-total=${Math.floor(limitBytesTotal)}`);
      return runCommand(conn, cmd);
    });
    if (!sync.ok) {
      return NextResponse.json({ error: `تعذرت إضافة المستخدم على الراوتر: ${sync.error ?? "خطأ غير معروف"}` }, { status: 502 });
    }
    const added = sync.value;
    if (!added?.ok) {
      return NextResponse.json({ error: `الراوتر رفض إضافة المستخدم: ${added?.error ?? "خطأ غير معروف"}` }, { status: 502 });
    }
    // Confirm the user really landed on the router before claiming success.
    // !done alone only means the command was accepted; a live print proves it.
    const verified = await withRouterRow(router, async (conn) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const list = await runCommand(conn, ["/ip/hotspot/user/print"]);
        if (list.ok && list.data.some((r) => (r.name ?? "").toLowerCase() === username.toLowerCase())) {
          return { found: true, attempts: attempt + 1 };
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 150));
      }
      return { found: false, attempts: 3 };
    });
    if (!verified.ok || !verified.value?.found) {
      // Roll the router back so we never leave a half-synced test user behind.
      await withRouterRow(router, async (conn) => {
        const list = await runCommand(conn, ["/ip/hotspot/user/print"]);
        const uid = list.data.find((r) => (r.name ?? "").toLowerCase() === username.toLowerCase())?.[".id"];
        if (uid) await runCommand(conn, ["/ip/hotspot/user/remove", `=.id=${uid}`]);
        return true;
      }).catch(() => {});
      return NextResponse.json({ error: `تم إرسال الأمر لكن المستخدم لم يظهر على الراوتر بعد التحقق (${verified.error ?? "غير موجود"})` }, { status: 502 });
    }
    routerSynced = true;

    const user = await db.hotspotUser.create({
      data: {
        username,
        password,
        fullName: b.fullName ? String(b.fullName) : null,
        phone: b.phone ? String(b.phone) : null,
        packageId: b.packageId || null,
        routerId: router.id,
        profile,
        status: suspended ? "suspended" : "active",
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : (selectedPkg?.durationHours ? new Date(Date.now() + Number(selectedPkg.durationHours) * 3600_000) : null),
        routerSynced,
      },
    });
    await db.activityLog.create({ data: { actor: ctx.username, action: "إضافة مستخدم", target: user.username, details: `router=${router.identity || router.name} synced=${routerSynced}` } });
    return NextResponse.json({ ok: true, user, routerSynced, router: router.identity || router.name });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const body = await req.json();
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) return NextResponse.json({ error: "حدد المستخدمين" }, { status: 400 });
    const users = await db.hotspotUser.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, routerId: true, routerSynced: true } });

    // Mirror deletions on the real router(s), grouped by router.
    let routerRemoved = 0;
    const routerErrors: string[] = [];
    const byRouter = new Map<string, typeof users>();
    for (const u of users.filter((x) => x.routerSynced)) {
      const key = u.routerId ?? "__default__";
      if (!byRouter.has(key)) byRouter.set(key, []);
      byRouter.get(key)!.push(u);
    }
    for (const [key, group] of byRouter) {
      const router = key === "__default__"
        ? await db.router.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } })
        : await db.router.findFirst({ where: { id: key } });
      if (!router) {
        routerErrors.push(`السيرفر غير موجود: ${key}`);
        continue;
      }
      const result = await withRouterRow(router, async (conn) => {
        const list = await runCommand(conn, ["/ip/hotspot/user/print"]);
        if (!list.ok) return { removed: 0, error: list.error ?? "فشل قراءة المستخدمين من الراوتر" };
        let removed = 0;
        const failed: string[] = [];
        for (const u of group) {
          const uid = list.data.find((r) => (r.name ?? "").toLowerCase() === u.username.toLowerCase())?.[".id"];
          if (!uid) continue; // already gone on the router — safe to clean locally
          const del = await runCommand(conn, ["/ip/hotspot/user/remove", `=.id=${uid}`]);
          if (del.ok) removed++;
          else failed.push(`${u.username}: ${del.error ?? "رفض الراوتر الحذف"}`);
        }
        return { removed, error: failed.join("; ") || undefined };
      });
      if (!result.ok || !result.value) {
        routerErrors.push(`${router.name}: ${result.error ?? "تعذر الاتصال"}`);
        continue;
      }
      routerRemoved += result.value.removed;
      if (result.value.error) routerErrors.push(`${router.name}: ${result.value.error}`);
    }

    // Never delete local rows when a synced router still shows the users.
    if (routerErrors.length) {
      return NextResponse.json({ error: `لم يُحذف المستخدمون من الراوتر: ${routerErrors.join(" | ")}`, routerRemoved }, { status: 502 });
    }

    const res = await db.hotspotUser.deleteMany({ where: { id: { in: ids } } });
    await db.activityLog.create({ data: { actor: ctx.username, action: "حذف مستخدمين", details: `${res.count} مستخدم (routerRemoved=${routerRemoved})` } });
    return NextResponse.json({ ok: true, count: res.count, routerRemoved });
  } catch (e) {
    return serverError(e);
  }
});
