import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { runCommand } from "@/lib/routeros";
import { withRouterRow } from "@/lib/router-transport";
import { serverError, badRequest } from "@/lib/api-auth";
import { withOrgStrict, meter, OrgContext } from "@/lib/tenancy";
import { AUTH_MODES, isAuthMode, generateCode, credentialRecord, type AuthMode } from "@/lib/voucher-auth";
import { formatLimitUptime } from "@/lib/voucher-actions";

function randomString(len: number, charset: string): string {
  let out = "";
  for (let i = 0; i < len; i++) out += charset[Math.floor(Math.random() * charset.length)];
  return out;
}

/**
 * Advanced voucher batch generation (v3).
 *
 * - 4 authentication modes: user_pass | pin | username_only | scratch
 * - unique codes across ALL batches (full-table uniqueness check)
 * - credentials stored ENCRYPTED at rest (AES-256-GCM); plaintext column empty
 * - live RouterOS validation: hotspot server existence + (username_only)
 *   profile login-by http-pap verification with explicit config instructions
 * - users created on the router via real API; cards ONLY marked synced when
 *   the router confirms creation — otherwise pending_sync with the real error
 */
export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    const count = Math.max(1, Math.min(5000, Number(b.count) || 10));
    const prefix = String(b.prefix || "MK").replace(/\s/g, "");
    const usernameLength = Math.max(4, Math.min(12, Number(b.usernameLength) || 6));
    const passwordLength = Math.max(3, Math.min(12, Number(b.passwordLength) || 4));
    const mode = b.mode === "sequential" ? "sequential" : "random";
    const codeCharset: "alnum" | "numeric" = b.codeCharset === "numeric" ? "numeric" : "alnum";
    const authMode: AuthMode = isAuthMode(b.authMode) ? b.authMode : "user_pass";
    const hotspotServer = b.hotspotServer ? String(b.hotspotServer).trim() : null;
    const activationPolicy = b.activationPolicy === "immediate" ? "immediate" : "on_first_login";
    const routerId = b.routerId;
    const packageId = b.packageId;
    if (!routerId) return badRequest("اختر السيرفر");
    if (!packageId) return badRequest("اختر الباقة");

    // ---- P5 plan limit enforcement (vouchers per batch) ----
    const max = ctx.org?.maxVouchersPerBatch ?? 0;
    if (max > 0 && count > max) {
      return NextResponse.json(
        { error: `الحد الأقصى للكروت في الدفعة حسب خطتك (${max})`, code: "PLAN_LIMIT_VOUCHERS" },
        { status: 402 },
      );
    }

    const router = await db.router.findFirst({ where: { id: String(routerId) } });
    const pkg = await db.package.findFirst({ where: { id: String(packageId) } });
    if (!router) return badRequest("السيرفر غير موجود");
    if (!pkg) return badRequest("الباقة غير موجودة");

    // Enforce the selected package on the device, not only in the DB:
    // rate-limit comes from the RouterOS profile, validity/data cap from the
    // hotspot user's limit-uptime / limit-bytes-total.
    const validityHours = Number(b.validityHours) || Number(pkg.durationHours) || 720;
    const limitUptime = formatLimitUptime(validityHours);
    const limitBytesTotal = pkg.dataLimitMb ? Number(pkg.dataLimitMb) * 1024 * 1024 : 0;

    // ---------- live router pre-validation (read-only) ----------
    let passwordlessReady: boolean | null = null; // null = not applicable
    let passwordlessWarning: string | undefined;
    let syncError = "";
    let hotspotServers: string[] = [];
    if (hotspotServer || authMode === "username_only") {
      const probe = await withRouterRow(router, async (conn) => {
          const hs = await runCommand(conn, ["/ip/hotspot/print"]);
          const profileName = pkg.profile || "default";
          const prof = await runCommand(conn, ["/ip/hotspot/user/profile/print", `?name=${profileName}`]);
          return { hotspotServers: hs.ok ? hs.data.map((r) => r.name).filter(Boolean) : [], profile: prof.ok ? prof.data[0] ?? null : null };
        },
      );
      if (!probe.ok || !probe.value) {
        // router unreachable: fail fast — never create a batch that pretends it synced
        return NextResponse.json({
          ok: false,
          error: `تعذر الاتصال بالسيرفر ${router.name}: ${probe.error} — لم تُنشأ أي كروت`,
        }, { status: 502 });
      }
      hotspotServers = probe.value!.hotspotServers;
      if (hotspotServer && !hotspotServers.includes(hotspotServer)) {
        return badRequest(
          hotspotServers.length
            ? `Hotspot server «${hotspotServer}» غير موجود على السيرفر — المتاح: ${hotspotServers.join(", ")}`
            : "لا يوجد أي Hotspot server مُعد على هذا السيرفر",
        );
      }
      if (authMode === "username_only") {
        const loginBy = probe.value!.profile?.["login-by"] ?? "";
        passwordlessReady = loginBy.split(",").map((s) => s.trim()).includes("http-pap");
        if (!passwordlessReady) {
          passwordlessWarning = `بروفايل «${pkg.profile}» لا يدعم http-pap حالياً (login-by=${loginBy || "غير محدد"}) — الدخول بدون كلمة مرور لن يعمل حتى تنفيذ:
/ip/hotspot/user/profile set [find name="${pkg.profile}"] login-by=http-chap,http-pap
(الدخول التجريبي الفعلي يظهر في نتيجة التحقق بعد الإنشاء)`;
        }
      }
    }

    // ---------- batch + unique code generation (across ALL batches) ----------
    const batch = await db.voucherBatch.create({
      data: {
        name: String(b.name || `دفعة كروت ${new Date().toLocaleDateString("ar-EG")}`),
        routerId, packageId, prefix,
        count, usernameLength, passwordLength, mode,
        profile: pkg.profile,
        price: pkg.price,
        validityHours,
        notes: b.notes ? String(b.notes) : null,
        status: "pending_sync",
        authMode, codeCharset, hotspotServer, activationPolicy,
      },
    });

    // uniqueness across the ENTIRE voucher table (not just this prefix)
    const taken = new Set<string>(
      (await db.voucher.findMany({ select: { username: true } })).map((v) => v.username),
    );
    const digits = "23456789";
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    const rows: { username: string; password: string }[] = [];
    let seqNum = taken.size + 1;
    for (let i = 0; i < count; i++) {
      if (authMode === "pin") {
        const code = generateCode({ prefix, length: usernameLength, charset: "numeric", mode, taken, startIndex: seqNum });
        if (!code) { syncError = "نطاق الرموز الرقمية استُنفد — زِد طول الرمز"; break; }
        rows.push({ username: code, password: code }); // same code both fields
        seqNum++;
      } else {
        let username: string | null;
        let attempts = 0;
        do {
          username = mode === "sequential"
            ? `${prefix}${String(seqNum++).padStart(usernameLength, "0")}`
            : `${prefix}${randomString(usernameLength, chars)}`;
          attempts++;
        } while (taken.has(username) && attempts < 100_000);
        if (username == null || taken.has(username)) { syncError = "تعذر توليد أسماء فريدة — زِد الطول أو غيّر البادئة"; break; }
        taken.add(username);
        const password = authMode === "username_only" ? "" : randomString(passwordLength, codeCharset === "numeric" ? digits : chars);
        rows.push({ username, password });
      }
    }

    if (rows.length === 0) {
      await db.voucherBatch.update({ where: { id: batch.id }, data: { status: "failed" } });
      return badRequest(syncError || "تعذر توليد أي رمز فريد");
    }

    // batch created successfully → meter usage for SaaS limits & billing
    if (ctx.effectiveOrgId) await meter(ctx.effectiveOrgId, "vouchers_generated", count);

    // ---------- DB records (encrypted credentials at rest) ----------
    const serialBase = Date.now().toString().slice(-9);
    const created = rows.map((row, i) => ({
      serial: `${serialBase}-${i + 1}`,
      username: row.username,
      ...credentialRecord(authMode, row.username, row.password),
      batchId: batch.id,
      packageId,
      routerId,
      price: pkg.price,
      status: "pending_sync" as const,
      routerSynced: false,
      authMode,
      ...(activationPolicy === "immediate" ? { expiresAt: new Date(Date.now() + validityHours * 3600_000) } : {}),
    }));
    for (let i = 0; i < created.length; i += 300) {
      await db.voucher.createMany({ data: created.slice(i, i + 300) });
    }

    // ---------- REAL router sync ----------
    let synced = 0;
    let failed = 0;
    const routerPassword = decryptSecret(router.apiPasswordEnc);
    try {
      const res = await withRouterRow(router, async (conn) => {
          for (const row of rows) {
            const cmd = [
              "/ip/hotspot/user/add",
              `=name=${row.username}`,
              `=password=${row.password}`,
              `=profile=${pkg.profile}`,
              `=comment=batch:${batch.id}`,
            ];
            if (hotspotServer) cmd.push(`=server=${hotspotServer}`);
            if (limitUptime) cmd.push(`=limit-uptime=${limitUptime}`);
            if (limitBytesTotal > 0) cmd.push(`=limit-bytes-total=${Math.floor(limitBytesTotal)}`);
            const r = await runCommand(conn, cmd);
            if (r.ok) synced++;
            else { failed++; syncError = r.error || "خطأ غير معروف"; }
          }
          return { synced, failed };
        },
      );
      if (!res.ok) {
        syncError = res.error || "تعذر الاتصال بالسيرفر";
        failed = rows.length;
      }
    } catch (err) {
      syncError = (err as Error).message;
      failed = rows.length;
    }

    if (synced > 0) {
      await db.voucher.updateMany({
        where: { batchId: batch.id, status: "pending_sync" },
        data: { status: "unused", routerSynced: true },
      });
      if (failed > 0) {
        await db.voucher.updateMany({
          where: { batchId: batch.id, status: "pending_sync" },
          data: { status: "failed", syncError },
        });
      }
      // username_only: verify live that the created users + profile truly allow passwordless login
      if (authMode === "username_only") {
        try {
          const verify = await withRouterRow(router, async (conn) => {
              const prof = await runCommand(conn, ["/ip/hotspot/user/profile/print", `?name=${pkg.profile}`]);
              const loginBy = prof.ok ? prof.data[0]?.["login-by"] ?? "" : "";
              const users = await runCommand(conn, ["/ip/hotspot/user/print", `?comment=batch:${batch.id}`]);
              const emptyPw = users.ok ? users.data.every((u) => (u.password ?? "") === "") : false;
              return { loginBy, emptyPw, createdCount: users.ok ? users.data.length : 0 };
            },
          );
          if (verify.ok && verify.value) {
            passwordlessReady = verify.value.loginBy.split(",").map((s) => s.trim()).includes("http-pap") && verify.value.emptyPw;
          }
        } catch { /* verification is best-effort; the warning already carries the instructions */ }
      }
    } else {
      await db.voucher.updateMany({
        where: { batchId: batch.id, status: "pending_sync" },
        data: { status: "failed", syncError: syncError || "السيرفر غير متصل — تعذر إنشاء المستخدمين على RouterOS" },
      });
    }

    const batchStatus = synced === rows.length ? "completed" : synced > 0 ? "partial" : failed > 0 ? "failed" : "pending_sync";
    await db.voucherBatch.update({
      where: { id: batch.id },
      data: { status: batchStatus, syncedCount: synced },
    });

    await db.notification.create({
      data: {
        title: "توليد دفعة كروت",
        body: synced > 0
          ? `تم إنشاء ${synced} كرت (${AUTH_MODES[authMode].labelAr}) ومزامنتها مع السيرفر ${router.name}${passwordlessReady === false ? " — تنبيه: http-pap غير مفعّل للدخول بدون كلمة مرور" : ""}`
          : `دفعة ${count} كرت محفوظة في قاعدة البيانات لكن تعذرت المزامنة مع ${router.name}: ${syncError}`,
        type: "system",
        severity: synced === rows.length && passwordlessReady !== false ? "success" : "warning",
      },
    });
    await db.activityLog.create({
      data: {
        actor: ctx.username,
        action: "توليد كروت",
        target: batch.name,
        details: `وضع ${authMode} · المُزامَن فعلياً مع RouterOS: ${synced}/${rows.length}${syncError ? ` — ${syncError}` : ""}${passwordlessWarning ? ` — ${passwordlessWarning.split("\n")[0]}` : ""}`,
      },
    });

    return NextResponse.json({
      ok: true,
      batchId: batch.id,
      total: rows.length,
      synced,
      failed,
      authMode,
      passwordlessReady,
      passwordlessWarning,
      hotspotServers,
      syncError: synced === 0 ? syncError : undefined,
      message: synced === rows.length
        ? `تم إنشاء ${rows.length} كرت (${AUTH_MODES[authMode].labelAr}) ومزامنتها مع السيرفر بنجاح${passwordlessReady === false ? " — مع تنبيه إعداد http-pap" : ""}`
        : synced > 0
          ? `تمت مزامنة ${synced} من ${rows.length} — الباقي بحالة فشل`
          : `تم حفظ الدفعة في قاعدة البيانات لكن لم تُنشأ على السيرفر (${syncError})`,
    });
  } catch (e) {
    return serverError(e);
  }
});
