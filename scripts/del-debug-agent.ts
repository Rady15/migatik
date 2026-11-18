import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const a = await (db as any).networkAgent.deleteMany({ where: { organizationId: "unassigned" } });
console.log("deleted unassigned test agents:", a.count);
process.exit(0);
