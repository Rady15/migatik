import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { badRequest, serverError } from "@/lib/api-auth";
import { withOrgStrict, OrgContext } from "@/lib/tenancy";

/**
 * v4 — one-command enrollment code for a Network Agent.
 *
 * POST { agentId } → generates (or regenerates) the bootstrap code, stores only
 * its SHA-256, and returns the plaintext code ONCE together with the ready
 * one-command install line. Regenerating instantly invalidates the previous
 * code (its hash is replaced).
 *
 * The code alphabet excludes visually ambiguous characters (0/O/1/I/l).
 */

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = crypto.randomBytes(32);
  let body = "";
  for (let i = 0; i < 32; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `mtcm-${body}`;
}

function originFrom(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json().catch(() => ({}));
    const agentId = String(b.agentId ?? "");
    if (!agentId) return badRequest("agentId مطلوب");

    const agent = await (db as any).networkAgent.findFirst({ where: { id: agentId } });
    if (!agent) return badRequest("الوكيل غير موجود");
    // org users may only enroll their own agents; platform staff (SUPER_ADMIN) may enroll any
    if (ctx.role !== "SUPER_ADMIN" && agent.organizationId !== ctx.effectiveOrgId) {
      return badRequest("الوكيل لا يتبع مؤسستك");
    }

    const code = newCode();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await (db as any).networkAgent.update({
      where: { id: agent.id },
      data: { enrollCodeHash: codeHash, enrollCodeHint: code.slice(-4) },
    });
    await db.activityLog.create({
      data: { actor: ctx.username, action: "agent:enroll_code", target: agent.name, details: "bootstrap code generated (hash stored only)" },
    }).catch(() => {});

    const origin = originFrom(req);
    return NextResponse.json({
      ok: true,
      code, // shown ONCE
      hint: code.slice(-4),
      command: `curl -fsSL "${origin}/api/agents/bootstrap?code=${code}" | bash`,
      platformUrl: origin,
      note: "شغّل الأمر داخل طرفية Linux داخل شبكة الراوتر (ليس طرفية MikroTik). كل استدعاء ناجح يُصدر رمزاً جديداً للوكيل ويُبطل الرمز السابق.",
    });
  } catch (e) {
    return serverError(e);
  }
});

export const GET = withOrgStrict(async (_req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const where = ctx.role === "SUPER_ADMIN" ? {} : { organizationId: ctx.effectiveOrgId };
    const agents = await (db as any).networkAgent.findMany({
      where,
      select: { id: true, name: true, enrollCodeHint: true, status: true, lastSeenAt: true },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ ok: true, agents });
  } catch (e) {
    return serverError(e);
  }
});
