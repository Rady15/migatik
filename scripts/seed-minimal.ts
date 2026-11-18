/**
 * Minimal production seed — creates ONLY the organization and the admin login.
 * No fake routers / users / vouchers / payments. Use this for a clean production
 * deployment; connect real routers afterwards via one-command enrollment.
 *
 * Run: npm run db:seed:minimal
 * Requires DATABASE_URL to point at the target database (env var or .env).
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto";

const db = new PrismaClient();
const ORG_CODE = "migatik";
const USERNAME = "admin";
const PASSWORD = "admin123";

async function main() {
  // Organization (idempotent)
  const org = await db.organization.upsert({
    where: { code: ORG_CODE },
    update: {},
    create: {
      code: ORG_CODE,
      name: "MikroTik Cloud Manager",
      plan: "trial",
      subscriptionStatus: "trialing",
      maxRouters: 10,
      maxUsers: 100,
      maxVouchersPerBatch: 500,
    },
  });
  console.log(`✓ organization: ${org.name} (${org.code})`);

  // Admin user (idempotent)
  const existing = await db.adminUser.findUnique({ where: { username: USERNAME } });
  if (!existing) {
    await db.adminUser.create({
      data: {
        username: USERNAME,
        name: "Rady Khaled",
        role: "SUPER_ADMIN",
        passwordHash: hashPassword(PASSWORD),
        active: true,
        organizationId: org.id,
      },
    });
    console.log(`✓ admin created: ${USERNAME} / ${PASSWORD}`);
  } else {
    // Ensure it can log in and is linked to the org
    await db.adminUser.update({
      where: { id: existing.id },
      data: { active: true, passwordHash: hashPassword(PASSWORD), organizationId: org.id, role: "SUPER_ADMIN" },
    });
    console.log(`✓ admin already exists — password reset to ${PASSWORD}`);
  }

  console.log("DONE — you can now log in and connect your first router.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
