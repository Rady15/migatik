import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const db = new PrismaClient();

async function main() {
  const agents = await (db as any).networkAgent.findMany();
  console.log("NetworkAgent rows:", agents.length);
  for (const a of agents) {
    console.log(JSON.stringify({
      id: a.id, name: a.name, status: a.status, version: a.version ?? null,
      organizationId: (a as any).organizationId ?? null,
      branchId: a.branchId ?? null, routerId: a.routerId ?? null,
      tokenHash: a.tokenHash ? a.tokenHash.slice(0, 16) + "..." : null,
      tokenHashLen: a.tokenHash?.length ?? 0,
      config: a.config ? a.config.slice(0, 120) : null,
      remoteIp: a.remoteIp ?? null,
      lastSeenAt: a.lastSeenAt, createdAt: a.createdAt,
    }));
  }
  // check if the enrollment code the user received matches any stored hash
  const candidates = [
    "mtcm-eRjXTMfxZVexZHaCNEvRNoCBw6cOq9a5",
    "eRjXTMfxZVexZHaCNEvRNoCBw6cOq9a5",
    "mtcm-DPuItwi4ffOCGQDRguaf3sr0LohCP5Ia",
    "DPuItwi4ffOCGQDRguaf3sr0LohCP5Ia",
  ];
  for (const c of candidates) {
    const h = crypto.createHash("sha256").update(c).digest("hex");
    const match = agents.find((a: any) => a.tokenHash === h);
    console.log(`code ${c.slice(0, 10)}... hash-match: ${match ? match.name + " (" + match.id + ")" : "NONE"}`);
  }
}

main().catch(console.error).finally(() => db.$disconnect());
