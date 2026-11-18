/**
 * One-time migration: encrypt existing voucher plaintext credentials at rest.
 * - rows with passwordEnc already set are skipped
 * - rows with empty password (username_only legacy or failed) are skipped
 * - after encryption the plaintext `password` column is cleared
 *
 * Run: bun run scripts/migrate-voucher-credentials.ts
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

async function main() {
  const rows = await db.voucher.findMany({ where: { passwordEnc: null }, select: { id: true, username: true, password: true, authMode: true } });
  let encrypted = 0, skippedEmpty = 0;
  for (const r of rows) {
    if (!r.password) { skippedEmpty++; continue; }
    const passwordEnc = encryptSecret(r.password);
    await db.voucher.update({ where: { id: r.id }, data: { passwordEnc, password: "" } });
    encrypted++;
  }
  console.log(`credential migration: ${encrypted} encrypted + plaintext cleared, ${skippedEmpty} skipped (empty), ${rows.length} examined`);
  const remaining = await db.voucher.count({ where: { AND: [{ passwordEnc: null }, { password: { not: "" } }] } });
  console.log(`remaining plaintext rows: ${remaining}`);
}

main().finally(() => db.$disconnect());
