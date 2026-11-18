/*
 * Generate the Prisma client with the right datasource provider for the current
 * environment.
 *
 * Local dev uses SQLite (prisma/schema.prisma + .env DATABASE_URL).
 * Vercel / production uses PostgreSQL (prisma/schema.prod.prisma) because the
 * serverless filesystem is read-only and SQLite cannot be written there.
 *
 * Selection rules (first match wins):
 *   1. PRISMA_SCHEMA env var, if set
 *   2. DATABASE_URL starts with postgres/postgresql -> prod schema
 *   3. VERCEL env var present -> prod schema
 *   4. otherwise -> local SQLite schema
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const envSchema = process.env.PRISMA_SCHEMA;
const dbUrl = process.env.DATABASE_URL || "";
const forceProd = /^postgres(ql)?:\/\//i.test(dbUrl) || Boolean(process.env.VERCEL);

let schema;
if (envSchema) {
  schema = envSchema;
} else if (forceProd) {
  schema = "prisma/schema.prod.prisma";
} else {
  schema = "prisma/schema.prisma";
}

const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

console.log(`[prisma-generate] using schema: ${schema}`);
try {
  execFileSync(process.execPath, [prismaCli, "generate", "--schema", schema], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
} catch (e) {
  console.error("[prisma-generate] failed:", e.message);
  process.exit(1);
}
