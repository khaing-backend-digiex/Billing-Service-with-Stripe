import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Kiểm các invariant của catalog mà DB KHÔNG tự giữ được.
 *
 *   npm run db:doctor         -> chỉ báo cáo, không sửa gì. Có vi phạm thì exit 1.
 *   npm run db:doctor -- --fix -> xoá những thứ chắc chắn an toàn (xem SAFE_TO_DELETE).
 *
 * Vì sao là script chứ không phải constraint: "mọi Plan phải có CreditPolicy" là quan hệ
 * 1-1 optional theo chiều Plan -> CreditPolicy. Không có cột nào trên Plan để ép NOT NULL,
 * và Prisma không diễn đạt được CHECK/trigger. Ép bằng trigger thì được, nhưng nó chặn cả
 * đường tạo hợp lệ (tạo Plan xong mới tạo policy trong cùng transaction). Nên: script +
 * báo động, chạy trong CI hoặc tay — đừng cố nhét vào schema.
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const FIX = process.argv.includes('--fix');

interface Finding {
  /** true = chặn (dữ liệu đang sai), false = cảnh báo (sẽ sai khi hệ thống lớn hơn). */
  blocking: boolean;
  title: string;
  detail: string[];
  /** Vì sao nó quan trọng — cái này mới là thứ người đọc log cần. */
  why: string;
}

const findings: Finding[] = [];

/**
 * Plan không có CreditPolicy. Đây là quả mìn im lặng: cấp credit tra policy, không thấy
 * thì log error rồi skip — không ai chết, không ai báo, chỉ là sub gắn vào plan đó KHÔNG
 * BAO GIỜ nhận credit.
 */
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
    // PricingOption trỏ tới Plan nên phải xoá con trước.
    const { count: optionCount } = await prisma.pricingOption.deleteMany({
      where: { planId: { in: planIds } },
    });
    const { count: planCount } = await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
    console.log(`\n[--fix] đã xoá ${planCount} Plan rác và ${optionCount} PricingOption của chúng.`);
  }
}

/**
 * StripeService.getFreePriceId() tra `findFirst({ code: 'FREE' })` KHÔNG kèm productId rồi
 * lấy pricingOptions[0]. Plan.code là @@unique([productId, code]) nên FREE tồn tại theo
 * TỪNG product — hai plan FREE là hàm đó thành tung đồng xu.
 */
async function checkFreePlanAmbiguity(): Promise<void> {
  const freePlans = await prisma.plan.findMany({
    where: { code: 'FREE' },
    include: { pricingOptions: true, product: true },
  });

  if (freePlans.length > 1) {
    findings.push({
      blocking: true,
      title: `${freePlans.length} plan có code FREE (trên ${new Set(freePlans.map((p) => p.productId)).size} product)`,
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
      title: `${multiOption.length} plan FREE có nhiều hơn 1 pricing option`,
      detail: multiOption.map((p) => `${p.code} – ${p.pricingOptions.length} option`),
      why: 'getFreePriceId() lấy pricingOptions[0] không kèm orderBy, nên chọn cái nào là do DB quyết.',
    });
  }
}

/** Không có providerPriceId thì không tạo sub trên Stripe được — option chỉ để trưng bày. */
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

/** BillingCycle chưa có @@unique([name, durationDay]) nên trùng lặp lọt được vào DB. */
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

async function main(): Promise<void> {
  console.log(FIX ? 'db:doctor (--fix: có xoá)\n' : 'db:doctor (chỉ đọc)\n');

  await checkPlansWithoutCreditPolicy();
  await checkFreePlanAmbiguity();
  await checkPricingOptionsWithoutPrice();
  await checkDuplicateBillingCycles();

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
