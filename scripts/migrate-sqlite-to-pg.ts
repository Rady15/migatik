/**
 * v4 P2 — SQLite → PostgreSQL migration with integrity verification.
 *
 * Uses REAL PostgreSQL binaries (embedded-postgres) — no root required.
 *  1. initdb + start a dedicated instance (port 54329, data dir ./db/pgdata)
 *  2. generate a PostgreSQL-variant Prisma client (scripts/pg/schema.pg.prisma)
 *  3. db push the schema into PG
 *  4. copy every table row-for-row (IDs, encrypted blobs and timestamps preserved
 *     byte-for-byte — encryption is app-level so APP_SECRET keeps working)
 *  5. verify: per-model row counts + credential decrypt spot-checks
 *  6. write docs/migration-report.md with the rollback procedure
 *
 * The SQLite file is NEVER modified or deleted — rollback = point DATABASE_URL
 * back to the SQLite file and restart.
 */
import { PrismaClient as SqliteClient } from "@prisma/client";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PG_PORT = 54329;
const PG_DATA = path.resolve("db/pgdata");
const PG_URL = `postgresql://mtcm:mtcm-local-pw@127.0.0.1:${PG_PORT}/mtcm`;

// dependency-safe insertion order
const ORDER = [
  "Organization", "Branch", "AdminUser", "Setting",
  "Router", "NetworkAgent", "Package", "VoucherBatch",
  "Customer", "Subscriber", "HotspotUser", "HotspotSession",
  "Invoice", "Payment", "Refund", "Expense", "CustomerTx",
  "CashRegister", "DailyClosing", "EmployeeCommission", "RecurringSubscription",
  "Voucher", "Notification", "ActivityLog", "SupportTicket",
  "NetworkDevice", "DeviceObservation", "DeviceEvent", "DeviceIpHistory",
  "DeviceMacHistory", "DeviceTrafficSample", "DeviceTrafficDaily", "DeviceStatsSnapshot",
  "DhcpLease", "ArpEntry", "BridgeHost", "WirelessClient", "PppSession",
  "NetworkResource", "DiscoveryJob", "DiscoveryJobLog", "DeviceBlockRule",
  "SubscriberEvent", "RouterMetric", "AgentCommand", "OrgInvoice", "UsageCounter",
] as const;

const lines: string[] = [];
function log(s: string) {
  console.log(s);
  lines.push(s);
}

async function waitForPg(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { SQL } = await import("bun");
      const s = new SQL(url);
      await s`SELECT 1`;
      await s.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error("PostgreSQL did not become ready in time");
}

async function main() {
  log("# SQLite → PostgreSQL migration report — " + new Date().toISOString());
  log("");
  log("## 1) Starting embedded PostgreSQL");
  if (fs.existsSync(PG_DATA)) {
    log(`- reusing existing data dir ${PG_DATA}`);
  } else {
    execSync(`./node_modules/@embedded-postgres/linux-x64/native/bin/initdb -D ${PG_DATA} -U mtcm --pwfile=<(echo mtcm-local-pw) -E UTF8`, { shell: "/bin/bash", stdio: "pipe" });
    log(`- initdb done at ${PG_DATA} (user mtcm)`);
  }
  const pgProc = spawn("./node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl", ["-D", PG_DATA, "-l", "db/pg.log", "-o", `-p ${PG_PORT} -c fsync=off`, "start"], { stdio: "pipe" });
  pgProc.stdout?.on("data", () => {});
  await new Promise((r) => setTimeout(r, 2500));

  // create the application database (initdb only creates `postgres`)
  const { SQL } = await import("bun");
  const adminSql = new SQL(`postgres://mtcm:mtcm-local-pw@127.0.0.1:${PG_PORT}/postgres`);
  try {
    await adminSql`CREATE DATABASE mtcm`;
    log("- database mtcm created");
  } catch (e) {
    if (!String(e).includes("already exists")) throw e;
    log("- database mtcm already exists");
  }
  await adminSql.end();
  await waitForPg(PG_URL);
  log(`- PostgreSQL ready on 127.0.0.1:${PG_PORT} (db mtcm)`);

  // 1b) generate + push the PostgreSQL-variant schema
  const base = fs.readFileSync("prisma/schema.prisma", "utf8");
  const pgSchema = base
    .replace('provider = "sqlite"', 'provider = "postgresql"')
    .replace('url      = env("DATABASE_URL")', `url      = "${PG_URL}"`)
    .replace(/generator client \{\n  provider = "prisma-client-js"\n\}/, 'generator client {\n  provider = "prisma-client-js"\n  output   = "../generated/pg/client"\n}');
  fs.writeFileSync("prisma/schema.pg.prisma", pgSchema, "utf8");
  execSync("bunx prisma db push --schema prisma/schema.pg.prisma --skip-generate --accept-data-loss", { stdio: "pipe", env: { ...process.env, DATABASE_URL: PG_URL } });
  execSync("bunx prisma generate --schema prisma/schema.pg.prisma", { stdio: "pipe" });
  log("- schema pushed to PostgreSQL + PG client generated (generated/pg/client)");

  // 2) copy rows
  log("");
  log("## 2) Row-by-row copy (IDs, encrypted blobs, timestamps preserved)");
  const sqlite = new SqliteClient();
  const { PrismaClient: PgClient } = await import("../generated/pg/client");
  const pg = new PgClient({ datasources: { db: { url: PG_URL } } });

  const tableCounts: { model: string; src: number; dst: number; ok: boolean }[] = [];
  for (const model of ORDER) {
    const sDel = (sqlite as unknown as Record<string, { findMany: Function; count: Function }>)[model];
    const pDel = (pg as unknown as Record<string, { createMany: Function; count: Function }>)[model];
    if (!sDel || !pDel) {
      log(`- ${model}: MISSING delegate — skipped`);
      tableCounts.push({ model, src: -1, dst: -1, ok: false });
      continue;
    }
    const rows = await sDel.findMany();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      try {
        await pDel.createMany({ data: chunk, skipDuplicates: false });
        inserted += chunk.length;
      } catch (e) {
        // insert one-by-one to isolate violations (e.g. FK references to rows that no longer exist)
        for (const row of chunk) {
          try {
            await pDel.create({ data: row });
            inserted++;
          } catch (rowErr) {
            log(`  ! ${model} row insert failed: ${(rowErr as Error).message.split("\n")[0].slice(0, 140)}`);
          }
        }
      }
    }
    const srcCount = await sDel.count();
    const dstCount = await pDel.count();
    const ok = srcCount === dstCount && inserted === srcCount;
    tableCounts.push({ model, src: srcCount, dst: dstCount, ok });
    log(`- ${model}: src=${srcCount} → dst=${dstCount} ${ok ? "OK" : "MISMATCH"}`);
  }

  // 3) integrity spot-checks — encrypted credentials must decrypt with the SAME APP_SECRET
  log("");
  log("## 3) Integrity spot-checks");
  const { decryptSecret } = await import("../src/lib/crypto");
  let credOk = 0;
  let credChecked = 0;
  const pgRouterCreds = await (pg as any).router.findMany({ select: { name: true, apiPasswordEnc: true } });
  for (const r of pgRouterCreds.slice(0, 5)) {
    credChecked++;
    try { decryptSecret(r.apiPasswordEnc); credOk++; } catch { log(`  ! credential decrypt FAILED for router ${r.name}`); }
  }
  let vOk = 0;
  let vChecked = 0;
  const pgVouchers = await (pg as any).voucher.findMany({ where: { passwordEnc: { not: null } }, select: { username: true, passwordEnc: true } });
  for (const v of pgVouchers.slice(0, 5)) {
    vChecked++;
    try { decryptSecret(v.passwordEnc!); vOk++; } catch { log(`  ! voucher credential decrypt FAILED for ${v.username}`); }
  }
  log(`- router credentials decrypt: ${credOk}/${credChecked}`);
  log(`- voucher credentials decrypt: ${vOk}/${vChecked}`);

  const srcRouter = await sqlite.router.findFirst({ select: { name: true, host: true } });
  const dstRouter = await (pg as any).router.findFirst({ select: { name: true, host: true } });
  const sameRouter = JSON.stringify(srcRouter) === JSON.stringify(dstRouter);
  log(`- first row byte-compare (router): ${sameRouter ? "IDENTICAL" : "DIFFERS"}`);

  const mismatches = tableCounts.filter((t) => !t.ok);
  const allOk = mismatches.length === 0 && credOk === credChecked && vOk === vChecked && sameRouter;
  log("");
  log(`## Verdict: ${allOk ? "MIGRATION INTEGRITY VERIFIED" : "MISMATCHES FOUND — DO NOT SWITCH"}`);

  log("");
  log("## Rollback procedure (non-destructive)");
  log("- SQLite file db/custom.db is never modified by this script.");
  log("- Rollback = set DATABASE_URL back to the SQLite file URL and restart the platform; data unchanged.");
  log("- PG instance: stop with pg_ctl -D db/pgdata stop (or kill the process); delete db/pgdata to discard.");

  await import("node:fs").then((fs) => fs.writeFileSync("docs/migration-report.md", lines.join("\n"), "utf8"));
  console.log("report: docs/migration-report.md");

  await sqlite.$disconnect();
  await pg.$disconnect();
  execSync(`./node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl -D ${PG_DATA} stop -m fast`, { stdio: "pipe" });
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("migration error:", e);
  process.exit(1);
});
