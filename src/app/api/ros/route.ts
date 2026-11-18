import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { withRouterCredentials } from "@/lib/discovery/sync-engine";
import { SECTIONS, readSection, validateCommand, buildWords, sanityCheck, writePaths, isMissingMenuError, type SectionDef } from "@/lib/ros-manager";
import { runCommand } from "@/lib/routeros";

/**
 * RouterOS section manager API (v3).
 * GET  ?routerId=&section=      → live read (real device data, with per-section error/unsupported)
 * POST { routerId, section, op: add|set|remove, data|rosId, confirm, allowInputRule }
 *
 * Safety: whitelisted paths per section + field whitelist + confirm for writes +
 * explicit acknowledgement for chain=input firewall rules + "mtcm-managed" tags
 * + a documented recovery procedure (never claim lockout is impossible).
 */
export const GET = withOrg(async (req: NextRequest) => {
  try {
    // Section catalogue (no router needed) — titles/columns/flags for the live UI.
    if (req.nextUrl.searchParams.get("meta") === "1") {
      return NextResponse.json({
        sections: Object.values(SECTIONS).map((s) => ({
          id: s.id,
          titleAr: s.titleAr,
          titleEn: s.titleEn,
          columns: s.columns ?? [],
          fields: s.fields,
          printPath: s.printPath,
          canAdd: Boolean(s.addPath),
          canSet: Boolean(s.setPath),
          canRemove: Boolean(s.removePath),
        })),
      });
    }
    const routerId = req.nextUrl.searchParams.get("routerId");
    const sectionId = req.nextUrl.searchParams.get("section") ?? "";
    if (!routerId) return badRequest("routerId مطلوب");
    if (!SECTIONS[sectionId]) return badRequest(`قسم غير معروف: ${sectionId}`);
    const router = await db.router.findFirst({ where: { id: String(routerId) }, select: { name: true, status: true, version: true, lastSyncAt: true } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });
    const res = await withRouterCredentials(routerId, (conn) => readSection(conn, sectionId));
    if (!res.ok && !res.value) {
      // connection-level failure
      return NextResponse.json({
        ok: false, error: res.error ?? "تعذر الاتصال بالسيرفر",
        section: SECTIONS[sectionId], router,
      }, { status: 502 });
    }
    const value = res.value as Awaited<ReturnType<typeof readSection>>;
    const section = value.section;
    return NextResponse.json({
      ok: value.ok,
      error: value.error,
      unsupported: value.unsupported,
      rows: value.rows,
      section: {
        id: section.id,
        titleAr: section.titleAr,
        titleEn: section.titleEn,
        fields: section.fields,
        columns: section.columns ?? [],
        // report the menu that actually answered (RouterOS 7 renaming)
        printPath: value.printPathUsed ?? section.printPath,
        canAdd: Boolean(section.addPath),
        canSet: Boolean(section.setPath),
        canRemove: Boolean(section.removePath),
      },
      router,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    const routerId = String(b.routerId ?? "");
    const sectionId = String(b.section ?? "");
    const op = String(b.op ?? "");
    const section: SectionDef | undefined = SECTIONS[sectionId];
    if (!routerId) return badRequest("routerId مطلوب");
    const router = await db.router.findFirst({ where: { id: String(routerId) } });
    if (!router) return NextResponse.json({ error: "السيرفر غير موجود" }, { status: 404 });
    if (!section) return badRequest(`قسم غير معروف: ${sectionId}`);
    if (!["add", "set", "remove"].includes(op)) return badRequest("op يجب أن يكون add|set|remove");
    if (op === "add" && !section.addPath) return badRequest("هذا القسم لا يدعم الإضافة");
    if (op === "set" && !section.setPath) return badRequest("هذا القسم لا يدعم التعديل");
    if (op === "remove" && !section.removePath) return badRequest("هذا القسم لا يدعم الحذف");
    if (b.confirm !== true) return badRequest("تتطلب عمليات الكتابة تأكيداً صريحاً (confirm=true) بعد مراجعة المعاينة");

    // firewall input-chain safety gate
    let inputAckNeeded = false;
    if (sectionId === "firewall_filter" && (op === "add" || op === "set")) {
      const chain = String(b.data?.chain ?? "");
      const action = String(b.data?.action ?? "");
      if (chain === "input" && action !== "accept") inputAckNeeded = true;
    }
    if (inputAckNeeded && b.allowInputRule !== true) {
      return NextResponse.json({
        ok: false,
        error: "قاعدة على chain=input قد تحجب جلسة الإدارة نفسها — راجع المعاينة ثم أعد الطلب مع allowInputRule=true للإقرار الصريح، أو استخدم recovery لحذف القواعد المُدارة بعد التطبيق",
        preview: b.data,
        recovery: "POST { section: firewall_filter, op: remove, recoveryManaged: true } يحذف كل قواعد mtcm-managed",
      }, { status: 428 });
    }

    const words: string[] = [];
    let path = "";
    if (op === "add") {
      path = section.addPath!;
      const built = buildWords(section, b.data ?? {});
      if (built.rejected.length) return badRequest(`حقول غير مسموحة في هذا القسم: ${built.rejected.join(", ")}`);
      if (built.words.length === 0) return badRequest("لا توجد حقول صالحة للإضافة");
      words.push(...built.words);
    } else if (op === "set") {
      path = section.setPath!;
      // Settings menus (DNS, CAPsMAN manager) have a single row with no .id.
      if (!b.rosId && section.removePath) return badRequest("rosId مطلوب للتعديل");
      const built = buildWords(section, b.data ?? {});
      if (built.rejected.length) return badRequest(`حقول غير مسموحة: ${built.rejected.join(", ")}`);
      if (built.words.length === 0) return badRequest("لا توجد حقول صالحة للتعديل");
      if (b.rosId) words.push(`=.id=${b.rosId}`);
      words.push(...built.words);
    } else {
      path = section.removePath!;
      if (b.recoveryManaged === true) {
        // recovery: remove ALL platform-managed rules of this section
        const res = await withRouterCredentials(routerId, async (conn) => {
          const list = await runCommand(conn, [section.printPath, "?comment=mtcm-managed"]);
          if (!list.ok) return { ok: false, error: list.error, removed: 0 };
          let removed = 0;
          for (const row of list.data) {
            if (row[".id"]) {
              const r = await runCommand(conn, [section.removePath!, `=.id=${row[".id"]}`]);
              if (r.ok) removed++;
            }
          }
          return { ok: true, removed, error: undefined };
        });
        if (!res.ok || !(res.value as { ok: boolean })?.ok) {
          return badRequest((res.error as string) ?? "فشل التنفيذ");
        }
        await db.activityLog.create({ data: { actor: ctx.username, action: `ros:recovery:${sectionId}`, target: routerId, details: `removed ${(res.value as { removed: number }).removed} managed rules` } });
        return NextResponse.json({ ok: true, recovered: (res.value as { removed: number }).removed });
      }
      if (!b.rosId) return badRequest("rosId مطلوب للحذف");
      words.push(`=.id=${b.rosId}`);
    }

    // managed tag on firewall/NAT adds (recovery anchor)
    if ((sectionId === "firewall_filter" || sectionId === "firewall_nat") && op === "add") {
      if (section.fields.includes("comment")) words.push("=comment=mtcm-managed");
    }

    const cmdErr = validateCommand(path, section);
    if (cmdErr) return badRequest(cmdErr);
    const alt = writePaths(section, op as "add" | "set" | "remove").fallback;
    if (alt) {
      const altErr = validateCommand(alt, section);
      if (altErr) return badRequest(altErr);
    }

    const res = await withRouterCredentials(routerId, async (conn) => {
      let r = await runCommand(conn, [path, ...words], 15000);
      // RouterOS 7 removed some legacy menus (caps-man → /interface/wifi/...) — retry the modern path.
      if (!r.ok && alt && isMissingMenuError(r.error)) {
        r = await runCommand(conn, [alt, ...words], 15000);
      }
      if (!r.ok) return { ok: false, error: r.error };
      // post-write sanity: can we still talk to the router? (anti-lockout check, not a guarantee)
      const sanity = await sanityCheck(conn);
      return { ok: true, sanity, data: r.data };
    });
    if (!res.ok) return badRequest(res.error ?? "فشل التنفيذ على السيرفر");
    const value = res.value as { ok: boolean; error?: string; sanity?: { ok: boolean; error?: string }; data?: Record<string, string>[] };
    if (!value.ok) return badRequest(value.error ?? "فشل التنفيذ");
    if (value.sanity && !value.sanity.ok) {
      return NextResponse.json({ ok: true, warning: value.sanity.error, message: "تم التنفيذ لكن فحص السلامة بعده فشل — تحقق من الوصول للإدارة فوراً" });
    }
    await db.activityLog.create({
      data: { actor: ctx.username, action: `ros:${op}:${sectionId}`, target: routerId, details: JSON.stringify(b.data ?? { rosId: b.rosId }).slice(0, 300) },
    });
    return NextResponse.json({ ok: true, message: "تم التنفيذ على السيرفر وتأكيد سلامة الاتصال بعده" });
  } catch (e) {
    return serverError(e);
  }
});
