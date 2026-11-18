/** Live probe: does org scoping actually apply for an org user via the API? */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto";
const db = new PrismaClient();
const BASE = "http://localhost:3000";

async function main() {
  const stamp = Date.now().toString(36);
  const org = await db.organization.create({ data: { code: `probe-${stamp}`, name: "Probe Org" } });
  const user = await db.adminUser.create({
    data: { username: `probe-${stamp}`, name: "Probe", passwordHash: hashPassword("probe123"), role: "ADMIN", organizationId: org.id, active: true },
  });
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user.username, password: "probe123" }),
  });
  const { token } = (await login.json()) as { token?: string };
  console.log("token:", !!token);
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  console.log("me:", (await me.text()).slice(0, 300));
  const routers = await fetch(`${BASE}/api/routers`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await routers.text();
  console.log("routers status:", routers.status);
  try {
    const j = JSON.parse(body);
    console.log("router count:", j.routers?.length ?? "n/a", "| first:", JSON.stringify(j.routers?.[0]?.name ?? j.error ?? body.slice(0, 120)));
  } catch { console.log("body:", body.slice(0, 200)); }
  // cleanup
  await db.adminUser.delete({ where: { id: user.id } });
  await db.organization.delete({ where: { id: org.id } });
  await db.$disconnect();
}
main();
