import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const rs = await (db as any).router.findMany({ select: { id: true, name: true, host: true, connectionMethod: true, agentId: true, isDemo: true, createdAt: true } });
console.log("router count:", rs.length);
for (const r of rs) console.log(JSON.stringify(r));
process.exit(0);
