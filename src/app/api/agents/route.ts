import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { serverError, badRequest } from "@/lib/api-auth";
import { decryptSecret } from "@/lib/crypto";
import { withOrg, withOrgStrict, OrgContext } from "@/lib/tenancy";
import { pushAgentConfig } from "@/lib/agent-tunnel";

/**
 * Remote Network Agents (v3).
 * GET    — list agents with live status (stale = no heartbeat in 60s)
 * POST   — register agent (returns the plaintext token ONCE; only SHA-256 stored)
 * PATCH  — update agent config (routers list is pushed to the agent over the
 *          outbound socket; credentials pulled from the encrypted Router rows)
 * DELETE — revoke agent (token hash row removed → socket auth fails)
 */
export const GET = withOrg(async () => {
  try {
    const agents = await db.networkAgent.findMany({
      orderBy: { createdAt: "desc" },
      include: { branch: { select: { name: true } }, router: { select: { name: true, host: true, status: true } } },
    });
    const staleMs = 60_000;
    return NextResponse.json({
      agents: agents.map((a) => ({
        id: a.id, name: a.name, version: a.version, status: a.status,
        remoteIp: a.remoteIp, capabilities: a.capabilities ? JSON.parse(a.capabilities) : [],
        branch: a.branch?.name ?? null, router: a.router?.name ?? null,
        lastSeenAt: a.lastSeenAt,
        online: a.lastSeenAt ? Date.now() - a.lastSeenAt.getTime() < staleMs : false,
        uptimeSec: a.lastSeenAt ? Math.floor((Date.now() - a.createdAt.getTime()) / 1000) : null,
      })),
    });
  } catch (e) {
    return serverError(e);
  }
});

export const POST = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json().catch(() => ({}));
    const name = String(b.name ?? "").trim() || "agent";
    // branch/router FKs must belong to the same organization
    if (b.branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(b.branchId) } });
      if (!branch) return badRequest("الفرع غير موجود");
    }
    if (b.routerId) {
      const router = await db.router.findFirst({ where: { id: String(b.routerId) } });
      if (!router) return badRequest("السيرفر غير موجود");
    }
    // token: 32 random bytes → base64url; store SHA-256 hash only
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const agent = await db.networkAgent.create({
      data: {
        name,
        tokenHash,
        branchId: b.branchId || null,
        routerId: b.routerId || null,
        status: "offline",
        config: b.config ? JSON.stringify(b.config) : null,
      },
    });
    await db.activityLog.create({ data: { actor: ctx.username, action: "agent:registered", target: name, details: "token generated (hash stored only)" } });
    return NextResponse.json({
      ok: true,
      agent: { id: agent.id, name: agent.name },
      token, // ← shown ONCE — copy it into AGENT_TOKEN on the agent host
      connectUrl: process.env.PUBLIC_AGENT_URL ?? "ws://<platform-host>:3003",
      note: "احفظ الرمز الآن — لن يظهر مرة أخرى. على جهاز الشبكة: AGENT_URL=... AGENT_TOKEN=... node agent.js أو استخدم install.sh",
    });
  } catch (e) {
    return serverError(e);
  }
});

export const PATCH = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const b = await req.json();
    const id = String(b.id ?? "");
    const agent = await db.networkAgent.findFirst({ where: { id }, include: { router: true } });
    if (!agent) return badRequest("الوكيل غير موجود");
    if (b.branchId) {
      const branch = await db.branch.findFirst({ where: { id: String(b.branchId) } });
      if (!branch) return badRequest("الفرع غير موجود");
    }
    if (b.routerId) {
      const router = await db.router.findFirst({ where: { id: String(b.routerId) } });
      if (!router) return badRequest("السيرفر غير موجود");
    }

    const data: Record<string, unknown> = {};
    if (b.name !== undefined) data.name = String(b.name);
    if (b.branchId !== undefined) data.branchId = b.branchId || null;
    if (b.routerId !== undefined) {
      data.routerId = b.routerId || null;
      // keep the primary-router link consistent with the multi-router assignment
      if (b.routerId) {
        await db.router.update({ where: { id: String(b.routerId) }, data: { connectionMethod: "agent", agentId: id } });
      }
    }
    // v4 multi-router assignment: every routerId in this list becomes agent-managed
    if (Array.isArray(b.routerIds)) {
      const ids = b.routerIds.map((x: unknown) => String(x)).filter(Boolean);
      for (const rid of ids) {
        const r = await db.router.findFirst({ where: { id: rid } });
        if (!r) return badRequest(`السيرفر غير موجود: ${rid}`);
      }
      await db.router.updateMany({ where: { id: { in: ids } }, data: { connectionMethod: "agent", agentId: id } });
    }
    // detach routers from this agent when requested
    if (Array.isArray(b.detachRouterIds)) {
      const ids = b.detachRouterIds.map((x: unknown) => String(x)).filter(Boolean);
      await db.router.updateMany({ where: { id: { in: ids }, agentId: id }, data: { connectionMethod: "direct", agentId: null } });
    }

    // build the remote router config from ALL routers assigned to this agent (decrypt credentials only in memory)
    let routersConfig: unknown[] = [];
    const managed = await db.router.findMany({ where: { agentId: id } });
    if (managed.length > 0) {
      routersConfig = managed.map((r) => ({
        name: r.name,
        host: r.host,
        port: r.useTls ? r.apiSslPort : r.apiPort,
        useTls: r.useTls,
        username: r.apiUsername,
        password: decryptSecret(r.apiPasswordEnc),
      }));
      data.config = JSON.stringify({ routers: routersConfig.map((r) => ({ ...(r as Record<string, unknown>), password: "***" })) });
    } else if (b.config !== undefined) {
      data.config = JSON.stringify(b.config);
    }

    const updated = await db.networkAgent.update({ where: { id }, data });
    // push live config over the authenticated internal bridge (realtime relays to the agent)
    const push = await pushAgentConfig(id, routersConfig);
    const configPush = push.detail === "sent" ? "sent" : push.detail;
    await db.activityLog.create({ data: { actor: ctx.username, action: "agent:config", target: agent.name } });
    return NextResponse.json({ ok: true, agent: updated, configPush });
  } catch (e) {
    return serverError(e);
  }
});

export const DELETE = withOrgStrict(async (req: NextRequest, ctx: OrgContext & { effectiveOrgId: string }) => {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return badRequest("id مطلوب");
    const agent = await db.networkAgent.delete({ where: { id } });
    await db.activityLog.create({ data: { actor: ctx.username, action: "agent:revoked", target: agent.name } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
});
