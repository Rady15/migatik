/**
 * Seed script — real records stored in the SQLite database.
 * Volumes match the reference dashboard design (2,850 users / $12,450 payments / 1,245 vouchers).
 * Run: bunx tsx scripts/seed.ts  (or: bun run scripts/seed.ts)
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret, hashPassword } from "../src/lib/crypto";

const db = new PrismaClient();

// deterministic PRNG for reproducible seeds
let s = 20261116;
function rnd(): number {
  s = (s * 1103515245 + 12345) % 2147483648;
  return s / 2147483648;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function between(min: number, max: number): number {
  return min + rnd() * (max - min);
}

const FIRST = ["محمد","أحمد","علي","سارة","محمود","فاطمة","خالد","ياسمين","عمر","نور","حسن","مريم","إبراهيم","هدى","مصطفى","آية","يوسف","دعاء","سعيد","ليلى","كريم","ملك","زياد","جنى","طارق","شيماء","باسم","منة","حسام","رانيا"];
const LAST = ["أحمد","محمد","علي","حسن","محمود","عبد الله","السيد","إبراهيم","مصطفى","خالد","سمير","عبد الرحمن","الشريف","عيسى","فؤاد","يوسف","مرسي","سعيد","زكي","نصار"];

async function main() {
  console.log("Clearing existing data...");
  await db.activityLog.deleteMany();
  await db.notification.deleteMany();
  await db.payment.deleteMany();
  await db.invoice.deleteMany();
  await db.expense.deleteMany();
  await db.voucher.deleteMany();
  await db.voucherBatch.deleteMany();
  await db.hotspotSession.deleteMany();
  await db.hotspotUser.deleteMany();
  await db.routerMetric.deleteMany();
  await db.package.deleteMany();
  await db.customer.deleteMany();
  await db.router.deleteMany();
  await db.supportTicket.deleteMany();
  await db.setting.deleteMany();
  await db.adminUser.deleteMany();

  // ===== admin =====
  await db.adminUser.create({
    data: {
      username: "admin",
      name: "راضي خالد",
      role: "ADMIN",
      passwordHash: hashPassword("admin123"),
    },
  });
  console.log("✓ admin user: admin / admin123");

  // ===== routers =====
  const routerData = [
    { name: "Main-Server", host: "192.168.1.1", apiPort: 8728, apiSslPort: 8729, useTls: true, location: "المركز الرئيسي", category: "main", apiUsername: "api-monitor", apiPassword: "Monitor#2026", notes: "السيرفر الرئيسي — إدارة الشبكة الأساسية" },
    { name: "Branch-01", host: "10.0.0.1", apiPort: 8728, apiSslPort: 8729, useTls: false, location: "الفرع الأول — المعادي", category: "branch", apiUsername: "api-monitor", apiPassword: "Branch1#2026", notes: "سيرفر الفرع الأول" },
    { name: "Branch-02", host: "10.0.0.2", apiPort: 8728, apiSslPort: 8729, useTls: false, location: "الفرع الثاني — مدينة نصر", category: "branch", apiUsername: "api-monitor", apiPassword: "Branch2#2026", notes: "سيرفر الفرع الثاني" },
  ];
  const routers: Record<string, string> = {};
  for (const r of routerData) {
    const { apiPassword, ...rest } = r;
    const rec = await db.router.create({
      data: { ...rest, apiPasswordEnc: encryptSecret(apiPassword), status: "untested" },
    });
    routers[r.name] = rec.id;
  }
  console.log("✓ 3 routers (status: untested — real API test required)");

  // ===== packages =====
  const pkgData = [
    { name: "Premium", description: "أسرع باقة للأعمال والمحترفين", downloadMbps: 25, uploadMbps: 12, dataLimitMb: null, durationHours: 720, price: 25, profile: "premium" },
    { name: "10 Mbps", description: "باقة شهرية متوازنة", downloadMbps: 10, uploadMbps: 5, dataLimitMb: null, durationHours: 720, price: 10, profile: "10m" },
    { name: "4 Mbps", description: "باقة شهرية اقتصادية", downloadMbps: 4, uploadMbps: 2, dataLimitMb: null, durationHours: 720, price: 5, profile: "4m" },
    { name: "2 Mbps", description: "باقة أسبوعية أساسية", downloadMbps: 2, uploadMbps: 1, dataLimitMb: 20480, durationHours: 168, price: 2, profile: "2m" },
    { name: "يومي سريع", description: "باقة يومية للزوار", downloadMbps: 8, uploadMbps: 4, dataLimitMb: 5120, durationHours: 24, price: 1.5, profile: "daily" },
    { name: "ساعة واحدة", description: "باقة بالساعة للمقاهي", downloadMbps: 6, uploadMbps: 3, dataLimitMb: 1024, durationHours: 1, price: 0.5, profile: "hourly" },
  ];
  const pkgs: Record<string, { id: string; name: string; price: number }> = {};
  for (const p of pkgData) {
    const rec = await db.package.create({ data: { ...p, currency: "USD" } });
    pkgs[p.name] = { id: rec.id, name: rec.name, price: rec.price };
  }
  console.log("✓ 6 packages");

  // ===== hotspot users (2,850) =====
  const total = 2850;
  const featured = [
    { username: "محمد أحمد", pkg: "10 Mbps", durationSec: 2 * 3600 + 15 * 60, ip: "192.168.10.24", mac: "48:BF:74:2C:11:A0" },
    { username: "أحمد علي", pkg: "Premium", durationSec: 1 * 3600 + 32 * 60, ip: "192.168.10.31", mac: "48:BF:74:2C:19:44" },
    { username: "سارة محمود", pkg: "4 Mbps", durationSec: 45 * 60, ip: "10.0.1.17", mac: "9C:B6:D0:1F:A2:8B" },
    { username: "علي حسن", pkg: "2 Mbps", durationSec: 20 * 60, ip: "10.0.2.52", mac: "B4:6D:83:70:C3:12" },
    { username: "محمود عبد الله", pkg: "10 Mbps", durationSec: 3 * 3600 + 12 * 60, ip: "192.168.10.45", mac: "5C:80:B4:2D:6E:91" },
  ];
  // distribution to match the design donut: 45% active / 33% suspended / 22% expired
  const nActive = Math.round(total * 0.45);   // 1283
  const nSuspended = Math.round(total * 0.33); // 941
  const nExpired = total - nActive - nSuspended; // 626

  type UserRow = {
    username: string; password: string; fullName: string; phone: string | null;
    packageId: string | null; routerId: string; profile: string; status: string;
    dataUsedMb: number; uptimeSec: number; expiresAt: Date | null; activatedAt: Date | null;
  };
  const rows: UserRow[] = [];
  const usedNames = new Set<string>(featured.map((f) => f.username));
  for (let i = 0; i < total - featured.length; i++) {
    let name = `${pick(FIRST)} ${pick(LAST)}`;
    while (usedNames.has(name)) name = `${pick(FIRST)} ${pick(LAST)} ${Math.floor(between(1, 999))}`;
    usedNames.add(name);
    const pkg = pick(pkgData);
    const routerId = routers[pick(["Main-Server", "Branch-01", "Branch-02", "Main-Server"])];
    const status = i < nActive - featured.length ? "active" : i < nActive + nSuspended - featured.length ? "suspended" : "expired";
    const uptime = Math.floor(between(600, 400 * 3600));
    rows.push({
      username: name,
      password: `${Math.floor(between(1000, 9999))}${pick(["a", "b", "c", "x", "k", "m"])}`,
      fullName: name,
      phone: `01${Math.floor(between(0, 3))}${Math.floor(between(10000000, 99999999))}`,
      packageId: pkgs[pkg.name].id,
      routerId,
      profile: pkg.profile,
      status,
      dataUsedMb: Math.floor(between(50, 90000)),
      uptimeSec: uptime,
      expiresAt: status === "expired" ? new Date(Date.now() - between(1, 30) * 86400e3) : new Date(Date.now() + between(1, 45) * 86400e3),
      activatedAt: new Date(Date.now() - between(10, 120) * 86400e3),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    await db.hotspotUser.createMany({ data: rows.slice(i, i + 500) });
  }
  const allUsers = await db.hotspotUser.findMany({ select: { id: true, username: true, packageId: true, routerId: true } });
  const now = Date.now();
  // create the 5 featured users (shown in the design's recent-users table)
  const featuredRouter = ["Main-Server", "Main-Server", "Branch-01", "Branch-02", "Main-Server"];
  for (let fi = 0; fi < featured.length; fi++) {
    const f = featured[fi];
    const pkgObj = pkgs[f.pkg];
    await db.hotspotUser.create({
      data: {
        username: f.username,
        password: String(Math.floor(between(1000, 9999))),
        fullName: f.username,
        phone: `01${Math.floor(between(0, 3))}${Math.floor(between(10000000, 99999999))}`,
        packageId: pkgObj.id,
        routerId: routers[featuredRouter[fi]],
        profile: pkgData.find((p) => p.name === f.pkg)!.profile,
        status: "active",
        dataUsedMb: Math.floor(between(2000, 24000)),
        uptimeSec: f.durationSec,
        expiresAt: new Date(now + between(10, 40) * 86400e3),
        activatedAt: new Date(now - between(15, 60) * 86400e3),
      },
    });
  }
  const byName = new Map(allUsers.map((u) => [u.username, u]));
  console.log(`✓ ${allUsers.length} hotspot users`);

  // ===== sessions: featured 5 (recent, like the design) + realistic history =====
  for (const f of featured) {
    const created = await db.hotspotUser.findUnique({ where: { username: f.username }, select: { id: true, username: true, packageId: true, routerId: true } });
    const u = created ?? byName.get(f.username);
    const routerId = u?.routerId ?? routers["Main-Server"];
    const dl = f.pkg === "Premium" ? between(14, 24) : between(6, 11);
    await db.hotspotSession.create({
      data: {
        userId: u?.id, username: f.username, routerId,
        ip: f.ip, mac: f.mac,
        startedAt: new Date(now - f.durationSec * 1000),
        durationSec: f.durationSec,
        uploadMb: between(40, 300), downloadMb: between(300, 2600),
        status: "active",
      },
    });
  }
  // another 35 active sessions (kept OLDER than the featured 5 so the design rows appear first)
  for (let i = 0; i < 35; i++) {
    const u = pick(allUsers);
    const routerId = u.routerId;
    const prefix = routerId === routers["Main-Server"] ? "192.168.10" : routerId === routers["Branch-01"] ? "10.0.1" : "10.0.2";
    await db.hotspotSession.create({
      data: {
        userId: u.id, username: u.username, routerId,
        ip: `${prefix}.${Math.floor(between(2, 250))}`,
        mac: Array.from({ length: 6 }, () => Math.floor(between(16, 255)).toString(16).padStart(2, "0").toUpperCase()).join(":"),
        startedAt: new Date(now - between(3.6 * 3600, 5 * 3600) * 1000),
        durationSec: Math.floor(between(300, 18000)),
        uploadMb: between(5, 400), downloadMb: between(50, 3000),
        status: "active",
      },
    });
  }
  // ended sessions history (~300)
  const ended: never[] = [];
  for (let i = 0; i < 300; i++) {
    const u = pick(allUsers);
    const dur = Math.floor(between(300, 14400));
    ended.push({
      userId: u.id, username: u.username, routerId: u.routerId,
      ip: `192.168.10.${Math.floor(between(2, 250))}`,
      startedAt: new Date(now - between(1, 14) * 86400e3),
      endedAt: new Date(now - between(1, 14) * 86400e3 + dur * 1000),
      durationSec: dur, uploadMb: between(1, 200), downloadMb: between(10, 1500),
      status: "ended",
    } as never);
  }
  for (let i = 0; i < ended.length; i += 200) {
    await db.hotspotSession.createMany({ data: ended.slice(i, i + 200) });
  }
  console.log("✓ sessions seeded");

  // ===== vouchers (1,245) =====
  const batches = [
    { name: "دفعة نوفمبر — باقة 10 ميجا", pkg: "10 Mbps", count: 400, price: 10 },
    { name: "دفعة نوفمبر — باقة 4 ميجا", pkg: "4 Mbps", count: 300, price: 5 },
    { name: "دفعة كروت يومية — مقاهي", pkg: "يومي سريع", count: 200, price: 1.5 },
    { name: "دفعة Premium — الشركات", pkg: "Premium", count: 150, price: 25 },
    { name: "دفعة أسبوعية — الفرع الأول", pkg: "2 Mbps", count: 100, price: 2 },
    { name: "كروت ساعة — المطار", pkg: "ساعة واحدة", count: 95, price: 0.5 },
  ];
  let serialN = 1;
  let voucherTotal = 0;
  const voucherStatuses = ["unused", "sold", "activated", "expired"];
  for (const b of batches) {
    const batch = await db.voucherBatch.create({
      data: {
        name: b.name, routerId: routers["Main-Server"], packageId: pkgs[b.pkg].id,
        prefix: "MK", count: b.count, usernameLength: 6, passwordLength: 4,
        mode: "random", profile: pkgData.find((p) => p.name === b.pkg)!.profile,
        price: b.price, validityHours: 720, notes: "دفعة مولّدة من النظام",
        status: "completed", syncedCount: 0, // never connected to a real router — honest status
      },
    });
    const vrows: { serial: string; username: string; password: string; batchId: string; packageId: string; routerId: string; price: number; currency: string; status: string; createdAt: Date; soldAt: Date | null }[] = [];
    for (let i = 0; i < b.count; i++) {
      const st = pick(voucherStatuses);
      const userPart = String(serialN).padStart(6, "0");
      vrows.push({
        serial: `MK-2026-${userPart}`,
        username: `MK${userPart}`,
        password: String(Math.floor(between(1000, 9999))),
        batchId: batch.id, packageId: pkgs[b.pkg].id, routerId: routers["Main-Server"],
        price: b.price, currency: "USD",
        status: st,
        createdAt: new Date(now - between(1, 25) * 86400e3),
        soldAt: st === "sold" || st === "activated" ? new Date(now - between(1, 20) * 86400e3) : null,
      });
      voucherTotal++;
      serialN++;
    }
    for (let i = 0; i < vrows.length; i += 300) {
      await db.voucher.createMany({ data: vrows.slice(i, i + 300) });
    }
  }
  console.log(`✓ ${voucherTotal} vouchers`);

  // ===== payments (total exactly $12,450; growth ~ +12%) =====
  // October (previous month) = 5,870 ; Nov 1..now = 6,580
  const monthNames = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const methods = ["cash", "bank", "electronic", "manual"];
  async function seedPayments(from: Date, to: Date, target: number, customerPool: string[], invoices: { id: string; total: number }[]) {
    const payments: { customerName: string; amount: number; method: string; createdAt: Date; invoiceId: string | null; reference: string | null; note: string | null; currency: string }[] = [];
    let remaining = target;
    while (remaining > 1) {
      const amount = remaining < 15 ? remaining : Math.round(between(2, 45) * 2) / 2;
      const d = new Date(between(from.getTime(), to.getTime()));
      payments.push({
        customerName: pick(customerPool),
        amount,
        method: pick(methods),
        createdAt: d,
        invoiceId: rnd() < 0.5 && invoices.length ? pick(invoices).id : null,
        reference: rnd() < 0.4 ? `TXN-${Math.floor(between(100000, 999999))}` : null,
        note: null,
        currency: "USD",
      });
      remaining -= amount;
    }
    for (const p of payments) await db.payment.create({ data: p });
    return payments.length;
  }
  // invoices first
  const invoiceRows: { id: string; total: number }[] = [];
  let invN = 1;
  const customersPool: string[] = [];
  {
    let i = 0;
    for (const u of allUsers.slice(0, 60)) customersPool.push(u.username);
    const invStatuses = ["paid", "paid", "paid", "unpaid", "overdue", "draft"];
    for (let i = 0; i < 40; i++) {
      const st = pick(invStatuses);
      const amount = Math.round(between(5, 60) * 2) / 2;
      const taxRate = 14;
      const discount = rnd() < 0.2 ? Math.round(between(1, 5) * 2) / 2 : 0;
      const taxAmount = Math.round(((amount - discount) * taxRate / 100) * 100) / 100;
      const total = Math.round((amount - discount + taxAmount) * 100) / 100;
      const created = new Date(now - between(1, 50) * 86400e3);
      const rec = await db.invoice.create({
        data: {
          number: `INV-2026-${String(invN++).padStart(4, "0")}`,
          customerName: pick(customersPool),
          customerPhone: `01${Math.floor(between(0, 3))}${Math.floor(between(10000000, 99999999))}`,
          description: pick(["اشتراك شهري — باقة 10 ميجا", "اشتراك شهري — Premium", "تجديد باقة 4 ميجا", "اشتراك أسبوعي", "تركيب وتأسيس خط"]),
          amount, discount, taxRate, taxAmount, total, status: st,
          dueDate: new Date(created.getTime() + 15 * 86400e3),
          createdAt: created,
        },
      });
      if (st !== "draft") invoiceRows.push({ id: rec.id, total });
    }
  }
  const octFrom = new Date("2026-10-01T00:00:00Z");
  const octTo = new Date("2026-10-31T23:59:59Z");
  const novFrom = new Date("2026-11-01T00:00:00Z");
  const n1 = await seedPayments(octFrom, octTo, 5870, customersPool, invoiceRows);
  const n2 = await seedPayments(novFrom, new Date(now), 6580, customersPool, invoiceRows);
  const allPay = await db.payment.aggregate({ _sum: { amount: true } });
  console.log(`✓ payments: ${n1 + n2} records, total = $${allPay._sum.amount?.toFixed(2)}`);
  console.log(`✓ invoices: ${invoiceRows.length + 6}`);

  // ===== expenses =====
  const expenseCats = ["operational", "salaries", "equipment", "maintenance", "other"];
  for (let i = 0; i < 25; i++) {
    await db.expense.create({
      data: {
        category: pick(expenseCats),
        description: pick(["صيانة أجهزة السيرفر", "رواتب فريق الدعم", "شراء راوترات جديدة", "كهرباء وإنترنت المكتب", "مستلزمات تشغيل", "اشتراكات وتراخيص"]),
        amount: Math.round(between(20, 400) * 2) / 2,
        createdAt: new Date(now - between(1, 45) * 86400e3),
      },
    });
  }
  console.log("✓ 25 expenses");

  // ===== router metrics (last 24h hourly, wavy like the design) =====
  for (const rName of Object.keys(routers)) {
    const scale = rName === "Main-Server" ? 1 : rName === "Branch-01" ? 0.55 : 0.4;
    const points = [];
    for (let h = 23; h >= 0; h--) {
      const hourOfDay = new Date(now - h * 3600e3).getUTCHours();
      const wave = Math.sin(((hourOfDay - 4) / 24) * Math.PI * 2) * 0.5 + 0.5;
      const dl = (75 + wave * 40 + between(-8, 8)) * scale;
      const ul = (30 + wave * 25 + between(-5, 5)) * scale;
      points.push({
        routerId: routers[rName],
        ts: new Date(now - h * 3600e3),
        downloadMbps: Math.max(2, Math.round(dl * 10) / 10),
        uploadMbps: Math.max(1, Math.round(ul * 10) / 10),
        cpuLoad: Math.round(between(15, 45) + wave * 20),
        activeUsers: Math.round((120 + wave * 200 + between(-30, 30)) * scale),
      });
    }
    await db.routerMetric.createMany({ data: points });
  }
  console.log("✓ router metrics 24h x3");

  // ===== notifications (3 unread like the badge) =====
  await db.notification.createMany({
    data: [
      { title: "دفعة كروت جديدة", body: "تم إنشاء دفعة كروت «دفعة نوفمبر — باقة 10 ميجا» بحجم 400 كرت", type: "system", severity: "success", read: false, createdAt: new Date(now - 25 * 60e3) },
      { title: "سيرفرات بانتظار الاختبار", body: "3 سيرفرات مسجلة لم يتم اختبار اتصال API فعلي بعد", type: "router", severity: "warning", read: false, createdAt: new Date(now - 2 * 3600e3) },
      { title: "فواتير غير مدفوعة", body: "توجد فواتير مستحقة تحتاج المتابعة مع العملاء", type: "financial", severity: "info", read: false, createdAt: new Date(now - 5 * 3600e3) },
      { title: "تقرير يومي جاهز", body: "تقرير الإيرادات اليومية متاح الآن في مركز التقارير", type: "financial", severity: "info", read: true, createdAt: new Date(now - 26 * 3600e3) },
      { title: "نسخة احتياطية", body: "تم إنشاء نسخة احتياطية من قاعدة البيانات بنجاح", type: "system", severity: "success", read: true, createdAt: new Date(now - 30 * 3600e3) },
    ],
  });
  console.log("✓ notifications");

  // ===== settings =====
  const mapUsers: Record<string, number> = {
    EG: 1245, SA: 400, AE: 240, IQ: 160, JO: 140, LY: 130, SD: 120, MA: 110, DZ: 100, YE: 95, SY: 80, KW: 30,
  };
  await db.setting.createMany({
    data: [
      { key: "org_name", value: "MikroTik Cloud Manager" },
      { key: "org_phone", value: "+20 100 000 0000" },
      { key: "currency", value: "USD" },
      { key: "tax_rate", value: "14" },
      { key: "map_users", value: JSON.stringify(mapUsers) },
      { key: "language", value: "ar" },
      { key: "theme", value: "dark" },
      { key: "voucher_prefix", value: "MK" },
    ],
  });
  console.log("✓ settings");

  // ===== support tickets =====
  await db.supportTicket.createMany({
    data: [
      { subject: "طلب تفعيل باقة Premium", message: "أرغب في الترقية إلى الباقة الاحترافية مع رفع السرعة إلى 25 ميجا", requester: "أحمد علي", priority: "medium", status: "open" },
      { subject: "مشكلة في بطاقة كرت", message: "الكرت رقم MK-2026-000032 لا يقبل تسجيل الدخول", requester: "سارة محمود", priority: "high", status: "in_progress" },
      { subject: "استفسار عن الفاتورة", message: "أحتاج نسخة من فاتورة الشهر الماضي", requester: "محمود عبد الله", priority: "low", status: "resolved" },
    ],
  });
  console.log("✓ support tickets");

  // ===== activity log =====
  await db.activityLog.createMany({
    data: [
      { actor: "النظام", action: "تهيئة النظام", details: "تمت تهيئة قاعدة البيانات وتحميل البيانات الأساسية" },
      { actor: "راضي خالد", action: "تسجيل دخول", details: "دخول أول للنظام" },
    ],
  });

  const counts = {
    users: await db.hotspotUser.count(),
    sessions: await db.hotspotSession.count(),
    vouchers: await db.voucher.count(),
    payments: await db.payment.count(),
    invoices: await db.invoice.count(),
    routers: await db.router.count(),
    metrics: await db.routerMetric.count(),
  };
  console.log("DONE", JSON.stringify(counts));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => db.$disconnect());
