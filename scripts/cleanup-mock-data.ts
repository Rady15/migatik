/**
 * MOCK DATA PERMANENT CLEANUP — v4
 * Deletes ALL seeded demo data, penetration-test artifacts, and fake records.
 * PRESERVES: admin account, default organization (الشبكة الرئيسية),
 *            real router 192.168.1.3, settings, network agents + enrollment codes.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const KEEP_ORG = "cmwizpr000000pwl2docp6cc3"; // الشبكة الرئيسية (default)
const KEEP_ROUTER_HOST = "192.168.1.3";

async function wipe(model: string, where: any = {}) {
  const m = (db as any)[model];
  if (!m) { console.log(`SKIP ${model} (not a model)`); return 0; }
  const r = await m.deleteMany({ where });
  console.log(`DEL ${model}: ${r.count}`);
  return r.count;
}

async function main() {
  const total = { deleted: 0 };

  // 0. Report what agents we keep (enrollment data)
  const agents = await db.networkAgent.findMany({ select: { id: true, name: true, orgId: true, online: true } } as any).catch(() => []);
  console.log("KEEP NetworkAgent rows:", JSON.stringify(agents));

  // 1. Device intelligence children → parents
  total.deleted += await wipe("DeviceObservation");
  total.deleted += await wipe("DeviceEvent");
  total.deleted += await wipe("DeviceIpHistory");
  total.deleted += await wipe("DeviceMacHistory");
  total.deleted += await wipe("DeviceTrafficSample");
  total.deleted += await wipe("DeviceTrafficDaily");
  total.deleted += await wipe("DeviceStatsSnapshot");
  total.deleted += await wipe("DhcpLease");
  total.deleted += await wipe("ArpEntry");
  total.deleted += await wipe("BridgeHost");
  total.deleted += await wipe("WirelessClient");
  total.deleted += await wipe("PppSession");
  total.deleted += await wipe("NetworkResource");
  total.deleted += await wipe("DeviceBlockRule");
  total.deleted += await wipe("DiscoveryJobLog");
  total.deleted += await wipe("DiscoveryJob");
  total.deleted += await wipe("NetworkDevice");
  total.deleted += await wipe("RouterMetric");
  total.deleted += await wipe("HotspotSession");

  // 2. Financial / billing mock data
  total.deleted += await wipe("CustomerTx");
  total.deleted += await wipe("Refund");
  total.deleted += await wipe("InvoiceItem").catch(() => 0);
  total.deleted += await wipe("OrgInvoice");
  total.deleted += await wipe("Invoice");
  total.deleted += await wipe("Payment");
  total.deleted += await wipe("Expense");
  total.deleted += await wipe("DailyClosing");
  total.deleted += await wipe("EmployeeCommission");
  total.deleted += await wipe("CashRegister");
  total.deleted += await wipe("RecurringSubscription");
  total.deleted += await wipe("UsageCounter");

  // 3. Subscriber lifecycle + hotspot + vouchers + packages
  total.deleted += await wipe("SubscriberEvent");
  total.deleted += await wipe("Subscriber");
  total.deleted += await wipe("Voucher");
  total.deleted += await wipe("VoucherBatch");
  total.deleted += await wipe("HotspotUser");
  total.deleted += await wipe("Customer");
  total.deleted += await wipe("Package");

  // 4. Ops noise: tickets, notifications, audit log, stale sessions
  total.deleted += await wipe("SupportTicket");
  total.deleted += await wipe("Notification");
  total.deleted += await wipe("ActivityLog");
  total.deleted += await wipe("AdminSession");

  // 5. Branches (all seeded/test branches)
  total.deleted += await wipe("Branch");

  // 6. Routers — keep ONLY the real one 192.168.1.3
  const routers = await db.router.findMany({ select: { id: true, name: true, host: true, isDemo: true } });
  for (const r of routers) {
    if (r.host === KEEP_ROUTER_HOST && !r.isDemo) {
      console.log(`KEEP Router: ${r.name} (${r.host})`);
      continue;
    }
    await db.router.delete({ where: { id: r.id } });
    console.log(`DEL Router: ${r.name} (${r.host}) isDemo=${r.isDemo}`);
    total.deleted++;
  }

  // 7. Organizations — keep ONLY the default org
  const orgs = await db.organization.findMany({ select: { id: true, name: true, code: true } });
  for (const o of orgs) {
    if (o.id === KEEP_ORG) { console.log(`KEEP Org: ${o.name} (${o.code})`); continue; }
    await db.organization.delete({ where: { id: o.id } }).catch(async () => {
      // force-clear any remaining org-scoped rows then retry
      await (db as any).branch.deleteMany({ where: { organizationId: o.id } });
      await (db as any).adminUser.updateMany({ where: { organizationId: o.id }, data: { organizationId: null } });
      return db.organization.delete({ where: { id: o.id } });
    });
    console.log(`DEL Org: ${o.name} (${o.code})`);
    total.deleted++;
  }

  console.log(`\nTOTAL deleted rows: ${total.deleted}`);

  // 8. Verification
  console.log("\n=== VERIFICATION (must show only real data) ===");
  console.log("Organizations:", await db.organization.count());
  console.log("Branches:", await db.branch.count());
  console.log("Routers:", await db.router.count());
  console.log("HotspotUsers:", await db.hotspotUser.count());
  console.log("Vouchers:", await db.voucher.count());
  console.log("Payments:", await db.payment.count());
  console.log("Invoices:", await db.invoice.count());
  console.log("Subscribers:", await db.subscriber.count());
  console.log("NetworkDevices:", await db.networkDevice.count());
  console.log("Packages:", await db.package.count());
  console.log("DiscoveryJobs:", await db.discoveryJob.count());
  console.log("ActivityLog:", await db.activityLog.count());
  console.log("AdminUsers:", await db.adminUser.count());
  console.log("Settings:", await db.setting.count());
  console.log("NetworkAgents:", await db.networkAgent.count());
  const keptRouters = await db.router.findMany({ select: { name: true, host: true } });
  console.log("Kept routers:", JSON.stringify(keptRouters));
}

main().catch(console.error).finally(() => db.$disconnect());
