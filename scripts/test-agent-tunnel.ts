/**
 * v4 E2E — Remote Agent as CGNAT/NAT-bypass remote access.
 *
 * Proves inside the sandbox (honest scope):
 *  1. A REAL agent process (agent/agent.js) connects OUTBOUND to the platform
 *     realtime service and shows ZERO listening ports (nothing to forward).
 *  2. The platform's full RouterOS binary client runs THROUGH the agent TCP
 *     tunnel (Next.js ⇄ :3003 ⇄ agent ⇄ router TCP) against a TEST-HARNESS
 *     RouterOS protocol simulator (NOT a router — plumbing proof only).
 *  3. MULTIPLE routers are managed through the SAME agent.
 *  4. The hotspot login test round-trips through the agent with HTTP evidence
 *     + API session verification (simulator-level, again plumbing proof).
 *  5. Unreachable targets produce honest failures, never fabricated success.
 *
 * Real-router acceptance = run the same flow on-site against 192.168.1.3
 * (integration-test.ts / browser). This script never claims that.
 */
import { spawn, ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { startSimulator } from "./ros-simulator";
import { withRouterCredentials } from "../src/lib/discovery/sync-engine";
import { enqueueAgentCommand } from "../src/lib/agent-commands";

const db = new PrismaClient();
const results: { name: string; pass: boolean; detail: string }[] = [];

function report(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  console.log("=== Agent CGNAT remote-access E2E (sandbox, honest scope) ===");

  // 0) realtime service up?
  try {
    const res = await fetch("http://127.0.0.1:3003", { method: "GET" }).catch(() => null);
    if (!res) throw new Error("not running");
    console.log("[i] realtime service already running on :3003");
  } catch {
    console.log("[i] starting realtime service on :3003");
    const rt = spawn("bun", ["run", "mini-services/realtime-service/index.ts"], { stdio: "ignore", detached: true });
    rt.unref();
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 1) simulator (TEST HARNESS — not a router)
  const sim = startSimulator({ apiPort: 18728, httpPort: 18729, identity: "MT-SIM-LAN" });
  console.log("[i] RouterOS protocol simulator (harness) on 127.0.0.1:18728 + hotspot web on :18729");

  // 2) register agent + spawn REAL agent process
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const agentRow = await db.networkAgent.create({
    data: { name: "lan-agent-e2e", tokenHash, status: "offline" },
  });
  const agentProc: ChildProcess = spawn("node", ["agent/agent.js"], {
    env: {
      ...process.env,
      AGENT_URL: "http://127.0.0.1:3003",
      AGENT_TOKEN: token,
      AGENT_NAME: "lan-agent-e2e",
    },
    stdio: "pipe",
  });
  const agentLogs: string[] = [];
  agentProc.stdout?.on("data", (d) => agentLogs.push(String(d)));
  agentProc.stderr?.on("data", (d) => agentLogs.push(String(d)));

  try {
    // 3) agent online?
    await waitFor(async () => {
      const a = await db.networkAgent.findUnique({ where: { id: agentRow.id } });
      return a?.status === "online" && a.lastSeenAt ? a : null;
    }, 15000, "agent online");
    report("agent outbound connect + heartbeat", true, "real agent.js process authenticated via token and went online");

    // 4) NAT property: zero listening ports on the agent process
    let listeners = "";
    try {
      listeners = execSync(`ss -tlnp 2>/dev/null | grep "pid=${agentProc.pid}," || true`).toString().trim();
    } catch { listeners = ""; }
    report("agent has NO listening ports (NAT/CGNAT-safe)", listeners === "", listeners ? `unexpected listeners: ${listeners}` : "ss -tlnp shows no LISTEN socket for the agent pid");

    // 5) TWO routers behind the SAME agent (multi-router per agent)
    const pwEnc = process.env.APP_SECRET ?? ""; // creds stored via app crypto below
    const { encryptSecret } = await import("../src/lib/crypto");
    const enc = encryptSecret("sim-pass");
    const r1 = await db.router.create({
      data: { name: "sim-router-1", host: "127.0.0.1", apiPort: 18728, apiUsername: "admin", apiPasswordEnc: enc, connectionMethod: "agent", agentId: agentRow.id, status: "untested" },
    });
    const r2 = await db.router.create({
      data: { name: "sim-router-2", host: "127.0.0.1", apiPort: 18728, apiUsername: "admin", apiPasswordEnc: enc, connectionMethod: "agent", agentId: agentRow.id, status: "untested" },
    });
    report("two routers assigned to one agent", true, `routers ${r1.id} / ${r2.id} → agentId ${agentRow.id}`);

    // 6) FULL RouterOS binary client through the tunnel — router 1
    const v1 = await withRouterCredentials(r1.id, async (conn) => {
      const { runCommand } = await import("../src/lib/routeros");
      return runCommand(conn, ["/system/resource/print"]);
    });
    report(
      "platform RouterOS client through agent tunnel (router 1)",
      v1.ok && v1.value?.ok === true && v1.value?.data?.[0]?.identity === "MT-SIM-LAN",
      v1.ok ? `identity=${v1.value?.data?.[0]?.identity} version=${v1.value?.data?.[0]?.version}` : `error: ${v1.error}`,
    );

    // 7) same through the SAME agent — router 2
    const v2 = await withRouterCredentials(r2.id, async (conn) => {
      const { runCommand } = await import("../src/lib/routeros");
      return runCommand(conn, ["/system/identity/print"]);
    });
    report(
      "second router through the same agent tunnel",
      v2.ok && v2.value?.ok === true && v2.value?.data?.[0]?.identity === "MT-SIM-LAN",
      v2.ok ? `identity=${v2.value?.data?.[0]?.identity}` : `error: ${v2.error}`,
    );

    // 8) DHCP leases through tunnel (feature-level proof: discovery data path)
    const v3 = await withRouterCredentials(r1.id, async (conn) => {
      const { runCommand } = await import("../src/lib/routeros");
      return runCommand(conn, ["/ip/dhcp-server/lease/print"]);
    });
    report(
      "DHCP lease read through agent tunnel",
      v3.ok && v3.value?.ok === true && (v3.value?.data?.length ?? 0) > 0,
      v3.ok ? `leases=${v3.value?.data?.length}` : `error: ${v3.error}`,
    );

    // 9) hotspot login test through the agent (HTTP evidence + API session verify)
    //    simulator accepts testuser1/testpass1 (user_pass mode shape)
    const hs = await enqueueAgentCommand<{ ok: boolean; verdict?: string; evidence?: Record<string, unknown>; error?: string }>(
      agentRow.id,
      "hotspot_login_test",
      { host: "127.0.0.1", httpPort: 18729, username: "testuser1", password: "testpass1" },
      { timeoutMs: 25000 },
    );
    const httpOk = hs.ok && hs.result?.ok === true && hs.result?.verdict === "login-accepted";
    report(
      "hotspot HTTP login test through agent",
      httpOk,
      hs.ok ? `verdict=${hs.result?.verdict} status=${(hs.result?.evidence as { statusCode?: number } | undefined)?.statusCode} loc=${(hs.result?.evidence as { location?: string } | undefined)?.location}` : `error: ${hs.error}`,
    );

    // 10) API session verification through tunnel after that login
    const active = await withRouterCredentials(r1.id, async (conn) => {
      const { runCommand } = await import("../src/lib/routeros");
      return runCommand(conn, ["/ip/hotspot/active/print"]);
    });
    const sawSession = active.ok && (active.value?.data ?? []).some((r) => r.user === "testuser1");
    report("active hotspot session verified via API (through tunnel)", sawSession, sawSession ? "session for testuser1 present in /ip/hotspot/active" : `error: ${active.error}`);

    // 11) honest failure: unreachable target through agent → clean error, no fabricated success
    const r3 = await db.router.create({
      data: { name: "sim-router-dead", host: "127.0.0.1", apiPort: 18999, apiUsername: "admin", apiPasswordEnc: enc, connectionMethod: "agent", agentId: agentRow.id, status: "untested" },
    });
    const dead = await withRouterCredentials(r3.id, async () => null);
    report(
      "unreachable router reports honest failure",
      !dead.ok && (dead.error ?? "").length > 0,
      `error returned: ${dead.error}`,
    );

    // cleanup test routers
    await db.router.deleteMany({ where: { id: { in: [r1.id, r2.id, r3.id] } } });
  } finally {
    try { agentProc.kill(); } catch {}
    sim.close();
    await db.agentCommand.deleteMany({ where: { agentId: agentRow.id } });
    await db.networkAgent.delete({ where: { id: agentRow.id } }).catch(() => {});
    await db.$disconnect();
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n=== RESULT: ${passCount}/${results.length} passed ===`);
  const md = [
    "# Agent tunnel E2E (sandbox) — " + new Date().toISOString(),
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail} |`),
    "",
    "Scope note: steps 6-10 use a **RouterOS protocol simulator (test harness)** — plumbing proof only, not a router. Real-router acceptance runs on-site.",
  ].join("\n");
  await import("node:fs").then((fs) => fs.writeFileSync("docs/agent-tunnel-report.md", md, "utf8"));
  console.log("report: docs/agent-tunnel-report.md");
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E error:", e);
  process.exit(1);
});
