/**
 * One-off (safe to re-run) backfill: make sure every card that was already
 * used/sold has its money recorded — invoice + payment + finance ledger entry —
 * and that "activated" cards (old wording for "used") are reported as "sold".
 *
 * Idempotent: ensureVoucherSale() never records the same card twice.
 *
 *   npm run db:backfill:voucher-sales
 */
import { db } from "../src/lib/db";
import { ensureVoucherSale } from "../src/lib/voucher-sales";

async function main() {
  const vouchers = await db.voucher.findMany({
    where: { status: { in: ["activated", "sold"] } },
    select: { id: true, username: true, status: true, price: true, soldAt: true, activatedAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[backfill] cards to inspect: ${vouchers.length}`);
  let invoicesCreated = 0;
  let statusFixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const v of vouchers) {
    try {
      if (v.status === "activated") {
        await db.voucher.update({
          where: { id: v.id },
          data: { status: "sold", soldAt: v.soldAt ?? v.activatedAt ?? new Date() },
        });
        statusFixed++;
      }
      const res = await ensureVoucherSale(v.id);
      if (res.created) invoicesCreated++;
      else if (!v.price || v.price <= 0) skipped++;
      console.log(`  ${v.username}: price=${v.price} ${res.created ? "→ invoice created" : res.ok ? "→ already recorded/free" : `→ ERROR ${res.error}`}`);
    } catch (e) {
      errors++;
      console.error(`  ${v.username}: FAILED ${(e as Error).message}`);
    }
  }

  console.log(`[backfill] done: statusFixed=${statusFixed} invoicesCreated=${invoicesCreated} skipped=${skipped} errors=${errors}`);
}

main()
  .catch((e) => {
    console.error("[backfill] fatal:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
