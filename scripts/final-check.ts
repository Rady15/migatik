import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const agent = await (db as any).networkAgent.findFirst({ where: { name: "lan-gw-1" }, select: { status: true, lastSeenAt: true, enrollCodeHint: true } });
const routers = await (db as any).router.findMany({ select: { name: true, host: true, connectionMethod: true, agentId: true } });
console.log(JSON.stringify({ agent, routers }));
process.exit(0);
