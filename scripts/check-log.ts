import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const logs = await (db as any).activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 25, select: { actor: true, action: true, target: true, details: true, createdAt: true } });
for (const l of logs) console.log(l.createdAt?.toISOString?.() ?? l.createdAt, "|", l.actor, "|", l.action, "|", l.target, "|", String(l.details ?? "").slice(0, 80));
process.exit(0);
