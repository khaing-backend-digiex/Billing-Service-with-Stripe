import 'dotenv/config';
import { PrismaClient, ResetInterval } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// `engineType = "none"` (schema.prisma) → client bắt buộc chạy qua driver adapter,
// giống PrismaService. `new PrismaClient()` trần sẽ ném PrismaClientInitializationError.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

/**
 * Seed catalog tối thiểu (§12 Bước 6, phần không phụ thuộc Stripe).
 *
 * Idempotent: chạy lại nhiều lần không tạo bản sao — dùng upsert theo unique key.
 *
 * KHÔNG seed PricingOption: mỗi PricingOption map 1-1 với một Stripe Price có thật
 * (§7), mà price id thì không bịa được offline. Tạo qua `POST /pricing/options` —
 * endpoint đó gọi Stripe rồi lưu lại id thật. Hệ quả cần biết: sau `--force-reset`,
 * `getFreePriceId()` trả null cho tới khi tạo lại pricing option, nên flow free plan
 * chưa chạy được ngay. Đây là giới hạn có chủ đích, không phải thiếu sót.
 */
async function main() {
  const product = await prisma.product.upsert({
    where: { code: 'AI' },
    update: {},
    create: {
      id: 'prod_ai_default',
      code: 'AI',
      name: 'Artificial Intelligence',
      // D7: add-on credit của AI cần sub live mới tiêu được; rớt Free thì đóng băng.
      addonRequiresLiveSubscription: true,
    },
  });

  const plans: Array<{
    code: string;
    name: string;
    isFree: boolean;
    creditAmount: number;
  }> = [
    { code: 'FREE', name: 'Gói free', isFree: true, creditAmount: 50 },
    { code: 'PRO', name: 'Gói pro', isFree: false, creditAmount: 100 },
  ];

  for (const p of plans) {
    const plan = await prisma.plan.upsert({
      where: { productId_code: { productId: product.id, code: p.code } },
      update: { name: p.name, isFree: p.isFree },
      create: {
        productId: product.id,
        code: p.code,
        name: p.name,
        isFree: p.isFree,
      },
    });

    await prisma.creditPolicy.upsert({
      where: { planId: plan.id },
      update: { creditAmount: p.creditAmount, resetInterval: ResetInterval.MONTHLY },
      create: {
        planId: plan.id,
        creditAmount: p.creditAmount,
        resetInterval: ResetInterval.MONTHLY,
      },
    });
  }

  const cycles = [
    { name: 'Monthly', durationDay: 30 },
    { name: 'Yearly', durationDay: 365 },
  ];
  for (const c of cycles) {
    const existing = await prisma.billingCycle.findFirst({ where: { name: c.name } });
    if (!existing) await prisma.billingCycle.create({ data: c });
  }

  console.log(`Seeded product ${product.code} + ${plans.length} plans with CreditPolicy`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
