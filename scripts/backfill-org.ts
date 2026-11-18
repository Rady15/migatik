/**
 * v4 backfill: assign every existing row to the default organization and set
 * up platform-level staff. Idempotent — safe to re-run.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const MODELS = [
  "router", "routerMetric", "package", "hotspotUser", "hotspotSession",
  "customer", "voucherBatch", "voucher", "invoice", "payment", "expense",
  "notification", "activityLog", "supportTicket", "networkDevice",
  "deviceObservation", "deviceEvent", "deviceIpHistory", "deviceMacHistory",
  "deviceTrafficSample", "deviceTrafficDaily", "deviceStatsSnapshot",
  "dhcpLease", "arpEntry", "bridgeHost", "wirelessClient", "pppSession",
  "networkResource", "discoveryJob", "discoveryJobLog", "deviceBlockRule",
  "branch", "subscriber", "subscriberEvent", "recurringSubscription",
  "customerTx", "refund", "cashRegister", "dailyClosing", "employeeCommission",
  "networkAgent", "agentCommand",
] as const;

async function main() {
  // 1) default organization
  let org = await db.organization.findUnique({ where: { code: "default" } });
  if (!org) {
    org = await db.organization.create({
      data: {
        code: "default",
        name: "الشبكة الرئيسية",
        plan: "enterprise",
        subscriptionStatus: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        maxRouters: 1000,
        maxUsers: 100,
        maxVouchersPerBatch: 5000,
      },
    });
    console.log("created default organization", org.id);
  }

  // 2) platform staff vs org users
  const superAdmins = await db.adminUser.updateMany({
    where: { role: "SUPER_ADMIN" },
    data: { organizationId: null },
  });
  const orgUsers = await db.adminUser.updateMany({
    where: { role: { not: "SUPER_ADMIN" }, organizationId: "unassigned" },
    data: { organizationId: org.id },
  });
  // legacy accounts created before v4 may have organizationId=null while NOT being
  // platform staff — they must land in the default org or they get locked out
  const legacyUsers = await db.adminUser.updateMany({
    where: { role: { not: "SUPER_ADMIN" }, organizationId: null },
    data: { organizationId: org.id },
  });
  console.log(`admins: ${superAdmins.count} platform, ${orgUsers.count} unassigned-scoped, ${legacyUsers.count} legacy-scoped`);

  // 3) backfill every tenant table
  let total = 0;
  for (const m of MODELS) {
    // @ts-expect-error dynamic delegate access
    const r = await db[m].updateMany({ where: { organizationId: "unassigned" }, data: { organizationId: org.id } });
    total += r.count;
    if (r.count) console.log(`${m}: ${r.count}`);
  }
  console.log(`TOTAL backfilled rows: ${total}`);

  // 4) organizationId of branches follows their organization when set
  await db.branch.updateMany({ where: { organizationId: org.id }, data: { organizationId: org.id } });
  console.log("done.");
}

main().finally(() => db.$disconnect());
