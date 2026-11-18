import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const tables = [
  "AdminUser", "Organization", "Branch", "Router", "AdminSession", "ActivityLog",
  "Notification", "HotspotUser", "Voucher", "VoucherBatch", "Package", "Payment",
  "Invoice", "InvoiceItem", "Expense", "CustomerTx", "CashSession", "Report",
  "Subscriber", "SubscriberEvent", "NetworkDevice", "DeviceObservation", "DeviceEvent",
  "DeviceIpHistory", "DeviceMacHistory", "DeviceTrafficSample", "DeviceTrafficDaily",
  "DeviceStatsSnapshot", "DhcpLease", "ArpEntry", "BridgeHost", "WirelessClient",
  "PppSession", "NetworkResource", "DiscoveryJob", "DiscoveryJobLog", "DeviceBlockRule",
  "AgentNode", "Setting", "SupportTicket", "ToolRun", "Agent", "RosAuditLog", "ApiUser",
];

async function main() {
  for (const t of tables) {
    try {
      const count = await (db as any)[t].count();
      if (count > 0) {
        let demoInfo = "";
        try {
          const demo = await (db as any)[t].count({ where: { isDemo: true } });
          if (demo > 0) demoInfo = ` (isDemo: ${demo})`;
        } catch {}
        console.log(`${t}: ${count}${demoInfo}`);
      }
    } catch {}
  }
}

main().catch(console.error).finally(() => db.$disconnect());
