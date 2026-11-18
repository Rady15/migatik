/**
 * Generate (or regenerate) a Network Agent enrollment code and print the
 * ready-to-paste one-command bootstrap line.
 *
 * Usage (from the project root, after setup.sh):
 *   bun run scripts/gen-agent-code.ts
 *   bun run scripts/gen-agent-code.ts --url http://192.168.1.10:3000
 *   bun run scripts/gen-agent-code.ts --name lan-gw-1 --url http://localhost:3000
 *
 * Notes:
 * - Same logic as POST /api/agents/enroll-code (code shown once, only the
 *   SHA-256 hash is stored; generating a new code invalidates the previous one).
 * - Run the printed command on a LINUX machine next to the router —
 *   NEVER inside a MikroTik/RouterOS terminal.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const PLATFORM_URL = (argValue("--url") ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const AGENT_NAME = argValue("--name") ?? "";

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const bytes = crypto.randomBytes(32);
  let body = "";
  for (let i = 0; i < 32; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `mtcm-${body}`;
}

const db = new PrismaClient();

async function main() {
  const agents: any[] = await (db as any).networkAgent.findMany({ orderBy: { createdAt: "asc" } });
  if (!agents.length) {
    console.error("لا يوجد أي Network Agent في قاعدة البيانات — افتح المنصة وأضف واحداً أولاً.");
    process.exit(1);
  }
  const agent = AGENT_NAME ? agents.find((a) => a.name === AGENT_NAME) : agents[agents.length - 1];
  if (!agent) {
    console.error(`Agent باسم "${AGENT_NAME}" غير موجود. الأسماء المتاحة: ${agents.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  const code = newCode();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  await (db as any).networkAgent.update({
    where: { id: agent.id },
    data: { enrollCodeHash: codeHash, enrollCodeHint: code.slice(-4) },
  });

  console.log("==============================================================");
  console.log(` كود تسجيل جديد للـ Agent: ${agent.name} (الصالح الآن فقط)`);
  console.log("==============================================================");
  console.log(` CODE : ${code}`);
  console.log("");
  console.log(" انسخ هذا الأمر ونفّذه في ترمينال LINUX بجوار الراوتر");
  console.log(" (تحذير: ليس داخل ترمينال MikroTik/RouterOS — لن يعمل هناك)");
  console.log("");
  console.log(` curl -fsSL "${PLATFORM_URL}/api/agents/bootstrap?code=${code}" | bash`);
  console.log("==============================================================");
  console.log(" بعد التشغيل سيظهر الـ Agent Online في المنصة ويكتشف أجهزة الشبكة تلقائياً.");
  console.log(" ملاحظة: توليد كود جديد لاحقاً يُلغي هذا الكود فوراً.");

  await db.$disconnect();
}

main().catch((e) => {
  console.error("فشل:", e.message);
  process.exit(1);
});
