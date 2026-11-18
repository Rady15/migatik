import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("=== Organizations ===");
  for (const o of await db.organization.findMany({ select: { id: true, name: true, code: true, active: true, plan: true, trialEndsAt: true, createdAt: true } }) as any) {
    console.log(JSON.stringify(o));
  }
  console.log("\n=== Branches ===");
  for (const b of await db.branch.findMany({ select: { id: true, name: true, organizationId: true } }) as any) {
    console.log(JSON.stringify(b));
  }
  console.log("\n=== Routers ===");
  for (const r of await db.router.findMany({ select: { id: true, name: true, host: true, isDemo: true, status: true, organizationId: true, createdAt: true } }) as any) {
    console.log(JSON.stringify(r));
  }
  console.log("\n=== Packages ===");
  for (const p of await db.package.findMany({ select: { id: true, name: true, price: true } }) as any) {
    console.log(JSON.stringify(p));
  }
  console.log("\n=== Subscribers ===");
  for (const s of await db.subscriber.findMany({ select: { id: true, name: true, status: true, routerId: true } }) as any) {
    console.log(JSON.stringify(s));
  }
  console.log("\n=== HotspotUser sample (5) ===");
  for (const h of await db.hotspotUser.findMany({ take: 5, select: { id: true, username: true, packageId: true } }) as any) {
    console.log(JSON.stringify(h));
  }
  console.log("\n=== Voucher sample (3) ===");
  for (const v of await db.voucher.findMany({ take: 3, select: { id: true, code: true, batchId: true } }) as any) {
    console.log(JSON.stringify(v));
  }
  console.log("\n=== Payment sample (3) ===");
  for (const p of await db.payment.findMany({ take: 3, select: { id: true, amount: true, hotspotUserId: true } }) as any) {
    console.log(JSON.stringify(p));
  }
  console.log("\n=== ActivityLog sample (5) ===");
  for (const a of await db.activityLog.findMany({ take: 5, orderBy: { createdAt: "desc" }, select: { id: true, action: true, details: true, createdAt: true } }) as any) {
    console.log(JSON.stringify(a).slice(0, 180));
  }
  console.log("\n=== SupportTicket ===");
  for (const t of await db.supportTicket.findMany({ select: { id: true, subject: true } }) as any) {
    console.log(JSON.stringify(t));
  }
  console.log("\n=== AdminUser ===");
  for (const u of await db.adminUser.findMany({ select: { id: true, username: true, name: true, role: true, organizationId: true } }) as any) {
    console.log(JSON.stringify(u));
  }
  console.log("\n=== NetworkDevice sample (8) ===");
  for (const d of await db.networkDevice.findMany({ select: { id: true, mac: true, hostname: true, routerId: true } }) as any) {
    console.log(JSON.stringify(d));
  }
}

main().catch(console.error).finally(() => db.$disconnect());
