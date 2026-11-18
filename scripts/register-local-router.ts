/**
 * Register the user's local MikroTik router (192.168.1.3) for real discovery.
 * Idempotent. Credentials must be updated from the Servers UI (they are stored
 * AES-256-GCM encrypted) — until then, sync attempts fail HONESTLY with the
 * real RouterOS error, never faking "online".
 *
 * Run: bun run scripts/register-local-router.ts
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

async function main() {
  const host = process.env.ROUTER_HOST ?? "192.168.1.3";
  const existing = await db.router.findFirst({ where: { host } });
  if (existing) {
    console.log(`Router for ${host} already exists: "${existing.name}" (${existing.id}) — nothing changed.`);
    return;
  }
  const router = await db.router.create({
    data: {
      name: process.env.ROUTER_NAME ?? "Core Router (192.168.1.3)",
      host,
      apiPort: 8728,
      apiSslPort: 8729,
      useTls: false,
      apiUsername: process.env.ROUTER_USER ?? "admin",
      // placeholder — MUST be replaced from the UI (Servers → edit → API password)
      apiPasswordEnc: encryptSecret(process.env.ROUTER_PASS ?? ""),
      location: "Local LAN",
      category: "main",
      notes: "سيرفر MikroTik المحلي — حدّث كلمة مرور API من إدارة السيرفرات لتفعيل الاكتشاف الفعلي",
      syncEnabled: true,
      syncIntervalSec: 60,
      status: "untested",
    },
  });
  console.log(`Registered router "${router.name}" (${router.id}) → ${router.host}:${router.apiPort}`);
  console.log("Update its API credentials from the Servers page to enable real discovery sync.");
}

main().finally(() => db.$disconnect());
