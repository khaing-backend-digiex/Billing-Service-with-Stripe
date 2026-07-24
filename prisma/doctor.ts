import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';


const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const FIX = process.argv.includes('--fix');

interface Finding {
  blocking: boolean;
  title: string;
  detail: string[];
  why: string;
}

const findings: Finding[] = [];

async function checkPlansWithoutCreditPolicy(): Promise<void> {
  const orphans = await prisma.plan.findMany({
    where: { creditPolicy: null },
    include: {
      _count: { select: { pricingOptions: true } },
      pricingOptions: {
        include: {
          _count: {
            select: { subscriptions: true, invoices: true, subscriptionEventsNew: true, subscriptionEventsOld: true },
          },
        },
      },
    },
  });
  if (orphans.length === 0) return;

  const refCount = (plan: (typeof orphans)[number]) =>
    plan.pricingOptions.reduce(
      (n, po) =>
        n +
        po._count.subscriptions +
        po._count.invoices +
        po._count.subscriptionEventsNew +
        po._count.subscriptionEventsOld,
      0,
    );

  const inUse = orphans.filter((p) => refCount(p) > 0);
  const unused = orphans.filter((p) => refCount(p) === 0);

  if (inUse.length > 0) {
    findings.push({
      blocking: true,
      title: `${inUse.length} Plan thiếu CreditPolicy nhưng ĐANG ĐƯỢC DÙNG`,
      detail: inUse.map(
        (p) =>
          `${p.code} (${p.id}) – ${p.pricingOptions.reduce((n, po) => n + po._count.subscriptions, 0)} subscription`,
      ),
      why:
        'Sub trên các plan này không bao giờ nhận credit: cấp credit tra policy, không thấy ' +
        'thì log error rồi skip. Doctor KHÔNG tự xoá — có sub trỏ tới thì đây là quyết định ' +
        'business (thêm policy hay chuyển sub sang plan khác), không phải dọn dẹp.',
    });
  }

  if (unused.length > 0) {
    findings.push({
      blocking: false,
      title: `${unused.length} Plan thiếu CreditPolicy, không ai tham chiếu`,
      detail: unused.map((p) => `${p.code} (${p.id}) – ${p._count.pricingOptions} pricing option`),
      why: 'Rác từ POST /pricing/plans gọi tay. Không sub/invoice/event nào trỏ tới nên xoá được: chạy `npm run db:doctor -- --fix`.',
    });
  }

  if (FIX && unused.length > 0) {
    const planIds = unused.map((p) => p.id);
    const { count: optionCount } = await prisma.pricingOption.deleteMany({
      where: { planId: { in: planIds } },
    });
    const { count: planCount } = await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
    console.log(`\n[--fix] đã xoá ${planCount} Plan rác và ${optionCount} PricingOption của chúng.`);
  }
}

async function checkFreePlanAmbiguity(): Promise<void> {
  const freePlans = await prisma.plan.findMany({
    where: { isFree: true },
    include: { pricingOptions: true, product: true },
  });

  if (freePlans.length > 1) {
    findings.push({
      blocking: true,
      title: `${freePlans.length} plan có isFree = true (trên ${new Set(freePlans.map((p) => p.productId)).size} product)`,
      detail: freePlans.map((p) => `${p.product.code}/${p.code} (${p.id})`),
      why:
        'getFreePriceId() không lọc theo productId nên trả về plan nào là ngẫu nhiên: user ' +
        'mới có thể rơi vào free plan của SAI product. Sửa thuộc src/stripe (Dev B): hàm cần nhận productId.',
    });
  }

  const multiOption = freePlans.filter((p) => p.pricingOptions.length > 1);
  if (multiOption.length > 0) {
    findings.push({
      blocking: true,
      title: `${multiOption.length} plan free có nhiều hơn 1 pricing option`,
      detail: multiOption.map((p) => `${p.code} – ${p.pricingOptions.length} option`),
      why: 'getFreePriceId() lấy pricingOptions[0] không kèm orderBy, nên chọn cái nào là do DB quyết.',
    });
  }
}

async function checkFreeDefinitionMismatch(): Promise<void> {
  const mismatched = await prisma.plan.findMany({
    where: {
      OR: [
        { isFree: true, code: { not: 'FREE' } },
        { isFree: false, code: 'FREE' },
      ],
    },
    include: { product: true },
  });
  if (mismatched.length === 0) return;

  findings.push({
    blocking: true,
    title: `${mismatched.length} plan mà isFree và code bất đồng`,
    detail: mismatched.map((p) => `${p.product.code}/${p.code} (${p.id}) – isFree=${p.isFree}`),
    why:
      'getFreePriceId() quyết định theo cột isFree, isAddonUsable() quyết định theo chuỗi ' +
      'code === "FREE". Plan nào hai bên bất đồng thì add-on của user trên plan đó không ' +
      'đóng băng đúng D7. Catalog seed hiện khớp cả hai nên chưa nổ — nhưng POST ' +
      '/pricing/plans cho đặt isFree tuỳ ý, nên đây là mìn chờ. Gốc: A5 (Bước 5) — bỏ ' +
      'PLAN_CODES, dùng Plan.isFree.',
  });
}

async function checkPricingOptionsWithoutPrice(): Promise<void> {
  const broken = await prisma.pricingOption.findMany({
    where: { isActive: true, OR: [{ providerPriceId: null }, { provider: null }] },
    include: { plan: true },
  });
  if (broken.length === 0) return;

  findings.push({
    blocking: true,
    title: `${broken.length} PricingOption đang active nhưng thiếu provider/providerPriceId`,
    detail: broken.map((po) => `${po.plan.code}/${po.name} (${po.id})`),
    why: 'Không có price id thì không đăng ký được trên Stripe. Chạy `npm run db:sync` để seed lại catalog.',
  });
}

async function checkDuplicateBillingCycles(): Promise<void> {
  const dupes = await prisma.$queryRaw<{ name: string; durationDay: number; count: bigint }[]>`
    SELECT name, "durationDay", COUNT(*) as count
    FROM "BillingCycle" GROUP BY name, "durationDay" HAVING COUNT(*) > 1
  `;
  if (dupes.length === 0) return;

  findings.push({
    blocking: false,
    title: `${dupes.length} BillingCycle bị trùng`,
    detail: dupes.map((d) => `${d.name} (${d.durationDay} ngày) – ${d.count} bản`),
    why:
      'BillingCycle thiếu @@unique([name, durationDay]) nên không upsert được, seed phải ' +
      'findFirst+create. Doctor không tự gộp: pricing option đang trỏ vào từng bản, gộp là đổi dữ liệu thật.',
  });
}

async function checkTransactionsWithoutGrant(): Promise<void> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "CreditTransaction" WHERE "grantId" IS NULL
  `;
  const count = Number(row.count);
  if (count === 0) return;

  findings.push({
    blocking: false,
    title: `${count} CreditTransaction không gắn grant nào (grantId NULL)`,
    detail: [`${count} hàng – lịch sử ghi bằng model cũ trước PR2`],
    why:
      'PR4 muốn siết CreditTransaction.grantId thành NOT NULL; còn hàng NULL thì migration ' +
      'đó sẽ gãy. Đây là lịch sử cũ, không phải lỗi đang chảy — chỉ là việc phải dọn trước PR4.',
  });
}

async function checkGrantsWithoutTransaction(): Promise<void> {
  const orphans = await prisma.$queryRaw<{ id: string; sourceType: string; amount: number }[]>`
    SELECT g."id", g."sourceType"::text AS "sourceType", g."amountGranted" AS amount
    FROM "CreditGrant" g
    WHERE NOT EXISTS (SELECT 1 FROM "CreditTransaction" t WHERE t."grantId" = g."id")
  `;
  if (orphans.length === 0) return;

  findings.push({
    blocking: true,
    title: `${orphans.length} CreditGrant không có transaction nào trỏ tới`,
    detail: orphans.map((g) => `${g.id} – ${g.sourceType}, ${g.amount} credit`),
    why:
      'CreditService luôn tạo grant + transaction trong cùng một DB transaction, nên grant ' +
      'trần nghĩa là credit vào bằng đường khác (INSERT tay / script backfill). Ledger và số ' +
      'dư đã lệch nhau: không truy được credit này từ đâu ra.',
  });
}

async function checkDuplicateGrantSource(): Promise<void> {
  const dupes = await prisma.$queryRaw<
    { userId: string; sourceRef: string; count: bigint }[]
  >`
    SELECT "userId", "sourceRef", COUNT(*) AS count
    FROM "CreditGrant"
    WHERE "sourceRef" IS NOT NULL
      AND "sourceType" = 'SUBSCRIPTION_ALLOCATION'
    GROUP BY "userId", "productId", "sourceRef"
    HAVING COUNT(*) > 1
  `;
  if (dupes.length === 0) return;

  findings.push({
    blocking: true,
    title: `${dupes.length} subscription được cấp ALLOCATION grant nhiều hơn một lần trong cùng kỳ`,
    detail: dupes.map((d) => `user ${d.userId} – sub ${d.sourceRef}: ${d.count} grant`),
    why:
      'Chỉ soi ALLOCATION (cấp theo hoá đơn): mỗi hoá đơn cấp đúng một lần nên trùng nghĩa ' +
      'là credit bị cấp đôi — thường do script INSERT thẳng chạy lại, không đi qua ' +
      'idempotencyKey của CreditService. KHÔNG soi SUBSCRIPTION_RESET: cron reset cấp một ' +
      'grant mỗi kỳ trên cùng một sub nên nhiều grant cùng sourceRef ở đó là ĐÚNG.',
  });
}

async function main(): Promise<void> {
  console.log(FIX ? 'db:doctor (--fix: có xoá)\n' : 'db:doctor (chỉ đọc)\n');

  await checkPlansWithoutCreditPolicy();
  await checkFreePlanAmbiguity();
  await checkFreeDefinitionMismatch();
  await checkPricingOptionsWithoutPrice();
  await checkDuplicateBillingCycles();
  await checkTransactionsWithoutGrant();
  await checkGrantsWithoutTransaction();
  await checkDuplicateGrantSource();

  if (findings.length === 0) {
    console.log('Không có vi phạm.');
    return;
  }

  for (const f of findings) {
    console.log(`${f.blocking ? '[CHẶN] ' : '[CẢNH BÁO]'} ${f.title}`);
    for (const line of f.detail.slice(0, 10)) console.log(`    - ${line}`);
    if (f.detail.length > 10) console.log(`    … và ${f.detail.length - 10} cái nữa`);
    console.log(`    ${f.why}\n`);
  }

  const blocking = findings.filter((f) => f.blocking).length;
  console.log(`${findings.length} vi phạm (${blocking} chặn).`);
  if (blocking > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
