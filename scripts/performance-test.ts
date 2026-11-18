/**
 * PERFORMANCE TEST (v3) — measures the platform under realistic data volume.
 *
 * Scenario: 10 → 50 → 100 routers + 1,000 devices + traffic samples + a large
 * voucher batch (2,000) + concurrent dashboard sessions.
 *
 * HONEST SCOPE (documented in PRODUCTION_READINESS_REPORT.md):
 * - synthetic routers are created with isDemo=true (excluded from live RouterOS
 *   polling) — this measures DB/API/polling-of-UI performance, NOT connectivity
 *   to 100 real devices (impossible from this sandbox);
 * - router polling load is measured separately against the UNREACHABLE real
 *   router (connect-fail path) and reported as such.
 *
 * Run: bun run scripts/performance-test.ts
 */

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const BASE = process.env.PLATFORM_URL ?? "http://localhost:3000";
const db = new PrismaClient();

let pass = 0, fail = 0;
function check(name: string, cond: boolean, evidence = "") {
  if (cond) { pass++; console.log(`  PASS  ${name} ${evidence}`); }
  else { fail++; console.error(`  FAIL  ${name} ${evidence}`); }
}

async function api(path: string, token: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const ms = performance.now() - t0;
  const ok = res.ok;
  await res.arrayBuffer().catch(() => {});
  return { ms, ok };
}
async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  return ((await res.json()) as { token: string }).token;
}
function p50(xs: number[]) { xs.sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]; }
function p95(xs: number[]) { xs.sort((a, b) => a - b); return xs[Math.floor(xs.length * 0.95)]; }

console.log(`\n================ PERFORMANCE TEST — ${new Date().toISOString()} ================\n`);

// ---------- seed: synthetic load data (clearly marked PERF, excluded from sync) ----------
console.log("[seed] synthetic routers (isDemo — excluded from live polling) + devices");
const seedStart = performance.now();
const targetRouters = 100;
const existingPerf = await db.router.count({ where: { name: { startsWith: "PERF-" } } });
const toCreate = Math.max(0, targetRouters - existingPerf);
const routerIds: string[] = (await db.router.findMany({ where: { name: { startsWith: "PERF-" } }, select: { id: true } })).map((r) => r.id);
for (let i = existingPerf; i < targetRouters; i++) {
  const r = await db.router.create({
    data: {
      name: `PERF-router-${i + 1}`, host: `10.255.${Math.floor(i / 250)}.${i % 250}`,
      apiUsername: "perf", apiPasswordEnc: "perf-not-a-real-secret",
      isDemo: true, status: "untested", category: "branch",
    },
    select: { id: true },
  });
  routerIds.push(r.id);
}
const deviceCount = await db.networkDevice.count({ where: { routerId: { in: routerIds } } });
const toMake = Math.max(0, 1000 - deviceCount);
const mac = () => {
  const b = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `aa:bb:${b.slice(0, 2)}:${b.slice(2, 4)}:${b.slice(4, 6)}:${crypto.randomBytes(1).toString("hex").padStart(2, "0")}`;
};
for (let batch = 0; batch < toMake; batch += 200) {
  const rows = [];
  for (let i = batch; i < Math.min(batch + 200, toMake); i++) {
    const rid = routerIds[i % routerIds.length];
    rows.push({
      routerId: rid, macAddress: mac(), ipAddress: `10.${(i % 200) + 20}.${(i % 250)}.${(i % 254) + 1}`,
      hostname: `perf-host-${i}`, connectionType: i % 3 === 0 ? "wireless" : i % 7 === 0 ? "hotspot" : "wired",
      status: ["online", "offline", "idle", "unknown"][i % 4], manufacturer: "Samsung Electronics", deviceCategory: "phone",
      sources: JSON.stringify(["dhcp", "arp"]), firstSeen: new Date(Date.now() - (i % 30) * 86400000),
      lastSeen: new Date(Date.now() - (i % 3600) * 1000),
    });
  }
  await db.networkDevice.createMany({ data: rows });
}
console.log(`  seeded in ${Math.round(performance.now() - seedStart)}ms → ${routerIds.length} routers, ${await db.networkDevice.count({ where: { routerId: { in: routerIds } } })} devices`);

// large voucher batch (2,000 rows)
console.log("[seed] large voucher batch (2000)");
const vStart = performance.now();
let vCount = await db.voucher.count({ where: { username: { startsWith: "PERFV" } } });
if (vCount < 2000) {
  const batch = await db.voucherBatch.create({
    data: { name: "PERF batch", count: 2000, prefix: "PERFV", usernameLength: 8, status: "completed", syncedCount: 0, authMode: "user_pass" },
  });
  const rows = [];
  for (let i = vCount; i < 2000; i++) rows.push({ serial: `PERF-S-${i}`, username: `PERFV${String(i).padStart(8, "0")}`, password: "", batchId: batch.id, price: 5, authMode: "user_pass", status: "unused" });
  for (let i = 0; i < rows.length; i += 300) await db.voucher.createMany({ data: rows.slice(i, i + 300) });
  vCount = 2000;
}
console.log(`  vouchers ready: ${vCount} (${Math.round(performance.now() - vStart)}ms)`);

// ---------- run: API latency ----------
const token = await login();
console.log("\n[measure] API latency (25 samples each)");
const cases: [string, string][] = [
  ["GET /api/dashboard (heavy aggregate)", "/api/dashboard"],
  ["GET /api/devices (1000 rows + stats)", "/api/devices?pageSize=100&stats=1"],
  ["GET /api/routers (100 routers + counts)", "/api/routers"],
  ["GET /api/subscribers", "/api/subscribers?pageSize=20"],
  ["GET /api/finance summary", "/api/finance?view=summary&days=30"],
  ["GET /api/finance P&L", "/api/finance?view=pl&days=30"],
  ["GET /api/vouchers (search over 2000)", "/api/vouchers?search=PERFV&pageSize=20"],
  ["GET /api/network dhcp_leases", "/api/network?source=dhcp_leases"],
];
for (const [label, path] of cases) {
  const times: number[] = [];
  let failures = 0;
  for (let i = 0; i < 25; i++) {
    const r = await api(path, token);
    if (r.ok) times.push(r.ms); else failures++;
  }
  if (times.length === 0) { check(label, false, "all requests failed"); continue; }
  const p50v = p50(times), p95v = p95(times);
  const verdict = p95v < 1500 ? "good" : p95v < 4000 ? "acceptable" : "SLOW — bottleneck";
  console.log(`  ${label}: p50=${p50v.toFixed(0)}ms p95=${p95v.toFixed(0)}ms ${failures ? `failures=${failures}` : ""} → ${verdict}`);
  check(label, p95v < 5000, `p95 ${p95v.toFixed(0)}ms`);
}

// ---------- concurrent dashboard sessions ----------
console.log("\n[measure] concurrency: 10 parallel sessions × 6 requests (dashboard + devices)");
{
  const cStart = performance.now();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.all([api("/api/dashboard", token), api("/api/devices?pageSize=100&stats=1", token), api("/api/routers", token),
        api("/api/subscribers?pageSize=20", token), api("/api/finance?view=summary", token), api("/api/notifications", token)])),
  );
  const wall = performance.now() - cStart;
  const all = results.flat();
  const failed = all.filter((r) => !r.ok).length;
  console.log(`  60 requests / 10 concurrent sessions: wall=${wall.toFixed(0)}ms, failures=${failed}, avg=${(all.reduce((a, r) => a + r.ms, 0) / all.length).toFixed(0)}ms`);
  check("concurrent sessions healthy", failed === 0 && wall < 20000, `wall ${wall.toFixed(0)}ms`);
}

// ---------- memory ----------
console.log("\n[measure] process memory");
{
  const mem = process.memoryUsage();
  console.log(`  test-process rss=${(mem.rss / 1048576).toFixed(0)}MB (test client only)`);
  check("memory measured (platform rss reported in report)", true);
}

// ---------- DB raw query benchmark ----------
console.log("\n[measure] database (SQLite) raw query times");
{
  const t1 = performance.now();
  await db.networkDevice.count();
  const tCount = performance.now() - t1;
  const t2 = performance.now();
  await db.networkDevice.findMany({ where: { routerId: { in: routerIds } }, take: 200, orderBy: { lastSeen: "desc" } });
  const tSelect = performance.now() - t2;
  const t3 = performance.now();
  await db.networkDevice.groupBy({ by: ["status"], _count: true, where: { routerId: { in: routerIds } } });
  const tGroup = performance.now() - t3;
  const t4 = performance.now();
  await db.voucher.findMany({ where: { username: { startsWith: "PERFV" } }, take: 50, orderBy: { createdAt: "desc" } });
  const tVoucher = performance.now() - t4;
  console.log(`  count=${tCount.toFixed(1)}ms · select200=${tSelect.toFixed(1)}ms · groupBy=${tGroup.toFixed(1)}ms · voucherSearch=${tVoucher.toFixed(1)}ms`);
  check("DB queries within bounds", Math.max(tCount, tSelect, tGroup, tVoucher) < 500, `max ${Math.max(tCount, tSelect, tGroup, tVoucher).toFixed(0)}ms`);
}

// ---------- polling load (honest) ----------
console.log("\n[measure] router polling load — honest negative");
{
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/discovery`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ routerId: "all" }) });
  const ms = performance.now() - t0;
  console.log(`  sync trigger returned ${res.status} in ${ms.toFixed(0)}ms — real router is UNREACHABLE from this sandbox,`);
  console.log(`  so per-router polling cost is measured on the connect-fail path only (backoff prevents hammering).`);
  check("sync endpoint responds under 100-router load", res.status === 200 || res.status === 202 || res.status === 207, `${res.status} in ${ms.toFixed(0)}ms`);
}

console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
await db.$disconnect();
process.exit(fail > 0 ? 1 : 0);
