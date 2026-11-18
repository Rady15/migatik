/**
 * (Re-)register the user's real MikroTik router 192.168.1.3 with REAL API
 * credentials (AES-256-GCM encrypted) and wire it to the Network Agent, so the
 * platform reaches it THROUGH the agent's outbound tunnel (NAT/CGNAT-safe).
 *
 * Run: bun run scripts/register-local-router-v4.ts
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

const HOST = "192.168.1.3";
const USER = process.env.ROUTER_USER ?? "admin";
const PASS = process.env.ROUTER_PASS ?? "radykh";
const AGENT_NAME = "lan-gw-1";

async function main() {
  const agent = await (db as any).networkAgent.findFirst({ where: { name: AGENT_NAME } });
  if (!agent) throw new Error(`agent not found: ${AGENT_NAME}`);
  const org = await (db as any).organization.findFirst({ where: { code: "default" } });

  const data = {
    organizationId: org?.id ?? "unassigned",
    name: "Core Router (192.168.1.3)",
    host: HOST,
    apiPort: 8728,
    apiSslPort: 8729,
    useTls: false,
    apiUsername: USER,
    apiPasswordEnc: encryptSecret(PASS),
    location: "Local LAN (customer site)",
    category: "main",
    notes: "سيرفر MikroTik الحقيقي — يُدار عبر الوكيل الشبكي داخل الشبكة (اتصال صادر فقط، يعمل خلف NAT/CGNAT)",
    syncEnabled: true,
    syncIntervalSec: 60,
    status: "untested",
    connectionMethod: "agent",
    agentId: agent.id,
  };

  const existing = await db.router.findFirst({ where: { host: HOST } });
  let router;
  if (existing) {
    router = await db.router.update({ where: { id: existing.id }, data });
    console.log(`updated router "${router.name}" (${router.id}) — agent=${AGENT_NAME}`);
  } else {
    router = await db.router.create({ data });
    console.log(`registered router "${router.name}" (${router.id}) — agent=${AGENT_NAME}`);
  }

  // config delivery: the realtime service rebuilds the REAL config (decrypted)
  // from the Router table on every agent (re)connect — no HTTP sidecar needed
  console.log("config delivery: agent receives real router config on next connect/reconnect");
}

main().catch(console.error).finally(() => db.$disconnect());
