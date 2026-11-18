import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const org = await (db as any).organization.findFirst({ where: { code: "default" } });
const r = await (db as any).router.findFirst({ where: { host: "192.168.1.3" } });
const a = await (db as any).networkAgent.findFirst({ where: { name: "lan-gw-1" } });
console.log(JSON.stringify({ routerOrg: r?.organizationId ?? null, routerId: r?.id ?? null, agentOrg: a?.organizationId ?? null, defaultOrg: org?.id ?? null }));
process.exit(0);
