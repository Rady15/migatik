/**
 * Generates a one-command enrollment code for a Network Agent.
 * Usage: bun run scripts/gen-enroll-code.ts <agentId|agentName>
 * The plaintext code is printed ONCE — only its SHA-256 is stored.
 */
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const db = new PrismaClient();
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

const PLATFORM_URL = process.env.PLATFORM_URL || "http://localhost:3000";

async function main() {
  const key = process.argv[2];
  if (!key) { console.error("usage: bun run scripts/gen-enroll-code.ts <agentId|agentName> [PLATFORM_URL]"); process.exit(1); }

  const agent = await (db as any).networkAgent.findFirst({
    where: key.startsWith("cmw") ? { id: key } : { name: key },
  });
  if (!agent) { console.error(`agent not found: ${key}`); process.exit(1); }

  let body = "";
  const bytes = crypto.randomBytes(32);
  for (let i = 0; i < 32; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  const code = `mtcm-${body}`;
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  await (db as any).networkAgent.update({
    where: { id: agent.id },
    data: { enrollCodeHash: codeHash, enrollCodeHint: code.slice(-4) },
  });
  await (db as any).activityLog.create({
    data: { actor: "admin", action: "agent:enroll_code", target: agent.name, details: "bootstrap code generated via scripts/gen-enroll-code.ts" },
  }).catch(() => {});

  console.log("agent        :", agent.name, `(${agent.id})`);
  console.log("code         :", code);
  console.log("hint         :", "…" + code.slice(-4));
  console.log("\nONE-COMMAND INSTALL (run inside a LINUX terminal in the router's LAN):\n");
  console.log(`curl -fsSL "${PLATFORM_URL}/api/agents/bootstrap?code=${code}" | bash`);
  console.log("\nNote: every successful bootstrap ROTATES the agent token — the newest");
  console.log("fetch wins; earlier installs of the same agent go offline.");
}

main().catch(console.error).finally(() => db.$disconnect());
