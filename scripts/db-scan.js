const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const tables = await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  console.log("TABLES:", tables.map(t => t.name).join(", "));
  const keywords = ['mock','demo','sample','fake','test','trial-org','example'];
  for (const t of tables) {
    const n = t.name;
    try {
      const cols = await p.$queryRawUnsafe(`PRAGMA table_info("${n}")`);
      const nameCol = cols.map(c=>c.name).find(c=>/name|title|username|email|label/i.test(c));
      const cnt = await p.$queryRawUnsafe(`SELECT COUNT(*) c FROM "${n}"`);
      let flag = '';
      if (nameCol) {
        const hits = await p.$queryRawUnsafe(`SELECT COUNT(*) c FROM "${n}" WHERE lower("${nameCol}") LIKE '%mock%' OR lower("${nameCol}") LIKE '%demo%' OR lower("${nameCol}") LIKE '%fake%' OR lower("${nameCol}") LIKE '%sample%'`);
        flag = hits[0].c > 0 ? ` <-- ${hits[0].c} MOCK-like rows` : '';
      }
      console.log(`${n}: ${cnt[0].c} rows${flag}`);
    } catch(e) { console.log(`${n}: ERR ${e.message.slice(0,60)}`); }
  }
  await p.$disconnect();
})();
