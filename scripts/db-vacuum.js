const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const ic1 = await p.$queryRawUnsafe("PRAGMA integrity_check");
  console.log("source integrity:", JSON.stringify(ic1));
  await p.$queryRawUnsafe("VACUUM INTO '/tmp/pkgstage/db/custom.db'");
  const ic2 = await p.$queryRawUnsafe("PRAGMA integrity_check");
  console.log("vacuum copy integrity:", JSON.stringify(ic2));
  const org = await p.$queryRawUnsafe("SELECT COUNT(*) c FROM Organization");
  const rt = await p.$queryRawUnsafe("SELECT COUNT(*) c FROM Router");
  const au = await p.$queryRawUnsafe("SELECT COUNT(*) c FROM AdminUser");
  console.log(`copy rows -> org:${org[0].c} router:${rt[0].c} admin:${au[0].c}`);
  await p.$disconnect();
})();
