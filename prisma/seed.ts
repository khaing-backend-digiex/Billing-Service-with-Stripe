import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PaymentProvider, PrismaClient, ResetInterval } from '@prisma/client';
import Stripe from 'stripe';
import { formatDatabaseAmountToStripe } from '../src/stripe/utils/stripe-currency.util';
import {
  RecurringSpec,
  ensureStripeProduct,
  ensureStripeRecurringPrice,
  stripePriceLookupKey,
  stripeProductId,
} from './stripe-catalog';

/**
 * Dựng catalog dev từ DB trắng, chạy được nhiều lần.
 *
 * Đích: clone repo -> `npx prisma migrate reset` -> đăng ký free plan chạy end-to-end.
 * `migrate reset` tự gọi seed này (khai ở prisma.config.ts, mục `migrations.seed`).
 *
 * `formatDatabaseAmountToStripe` là hàm thuần đổi định dạng tiền của Stripe (zero-decimal),
 * không phải service business — import để dùng chung là đúng, chép lại mới nguy hiểm vì
 * lệch nghĩa là sai số tiền. Ngược lại, seed KHÔNG mượn heuristic suy `interval` từ
 * `durationDay` trong PricingService: seed biết SKU của chính nó nên khai `recurring`
 * thẳng, đỡ phụ thuộc vào một quy tắc có thể đổi.
 */

interface OptionSeed {
  cycleName: string;
  durationDay: number;
  currency: string;
  /** Đơn vị của DB (đô la), không phải cent. Đổi sang cent ngay trước khi gửi Stripe. */
  price: number;
  recurring: RecurringSpec;
}

interface PlanSeed {
  code: string;
  name: string;
  isFree: boolean;
  creditAmount: number;
  resetInterval: ResetInterval;
  options: OptionSeed[];
}

interface ProductSeed {
  code: string;
  name: string;
  plans: PlanSeed[];
}

const MONTHLY: RecurringSpec = { interval: 'month', intervalCount: 1 };

/**
 * CHỈ MỘT product có plan FREE, có chủ đích — xem cảnh báo ở cuối file.
 * Mọi Plan đều phải có CreditPolicy: thiếu policy thì cấp credit bị log error rồi skip,
 * tức sub gắn vào plan đó không bao giờ nhận credit (invariant của C4).
 */
const CATALOG: ProductSeed[] = [
  {
    code: 'AI',
    name: 'Artificial Intelligence',
    plans: [
      {
        code: 'FREE',
        name: 'Free',
        isFree: true,
        creditAmount: 50,
        resetInterval: ResetInterval.MONTHLY,
        options: [
          {
            cycleName: 'Monthly',
            durationDay: 30,
            currency: 'usd',
            price: 0,
            recurring: MONTHLY,
          },
        ],
      },
      {
        code: 'PRO',
        name: 'Pro',
        isFree: false,
        creditAmount: 100,
        resetInterval: ResetInterval.MONTHLY,
        options: [
          {
            cycleName: 'Monthly',
            durationDay: 30,
            currency: 'usd',
            price: 10,
            recurring: MONTHLY,
          },
        ],
      },
    ],
  },
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function requireStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'Thiếu STRIPE_SECRET_KEY. Seed phải tạo Price thật trên Stripe vì providerPriceId ' +
        'không bịa offline được — không có nó thì getFreePriceId() trả null và user mới ' +
        'không đăng ký được free plan.',
    );
  }
  return new Stripe(key);
}

/** BillingCycle.name chưa có @@unique nên upsert theo name là không được (xem cảnh báo cuối file). */
async function ensureBillingCycle(name: string, durationDay: number) {
  const existing = await prisma.billingCycle.findFirst({ where: { name, durationDay } });
  if (existing) return existing;
  return prisma.billingCycle.create({ data: { name, durationDay } });
}

async function main() {
  const stripe = requireStripe();

  for (const productSeed of CATALOG) {
    const product = await prisma.product.upsert({
      where: { code: productSeed.code },
      update: { name: productSeed.name },
      create: { code: productSeed.code, name: productSeed.name, isActive: true },
    });
    console.log(`Product ${product.code}: ${product.id}`);

    for (const planSeed of productSeed.plans) {
      const plan = await prisma.plan.upsert({
        where: { productId_code: { productId: product.id, code: planSeed.code } },
        update: { name: planSeed.name, isFree: planSeed.isFree },
        create: {
          productId: product.id,
          code: planSeed.code,
          name: planSeed.name,
          isFree: planSeed.isFree,
        },
      });

      await prisma.creditPolicy.upsert({
        where: { planId: plan.id },
        update: {
          creditAmount: planSeed.creditAmount,
          resetInterval: planSeed.resetInterval,
        },
        create: {
          planId: plan.id,
          creditAmount: planSeed.creditAmount,
          resetInterval: planSeed.resetInterval,
        },
      });
      console.log(`  Plan ${plan.code}: ${plan.id} (${planSeed.creditAmount} credits)`);

      const stripeProduct = await ensureStripeProduct(
        stripe,
        stripeProductId(productSeed.code, planSeed.code),
        `${productSeed.name} - ${planSeed.name}`,
      );
      console.log(
        `    Stripe product ${stripeProduct.id} (${stripeProduct.created ? 'tạo mới' : 'tái dùng'})`,
      );

      for (const optionSeed of planSeed.options) {
        const billingCycle = await ensureBillingCycle(optionSeed.cycleName, optionSeed.durationDay);

        const price = await ensureStripeRecurringPrice(stripe, {
          productId: stripeProduct.id,
          lookupKey: stripePriceLookupKey(
            productSeed.code,
            planSeed.code,
            optionSeed.cycleName,
            optionSeed.currency,
          ),
          unitAmount: formatDatabaseAmountToStripe(optionSeed.price, optionSeed.currency),
          currency: optionSeed.currency,
          recurring: optionSeed.recurring,
        });
        console.log(
          `    Stripe price ${price.id} (${price.created ? 'tạo mới' : 'tái dùng'})`,
        );

        await prisma.pricingOption.upsert({
          where: {
            planId_billingCycleId_currency_provider: {
              planId: plan.id,
              billingCycleId: billingCycle.id,
              currency: optionSeed.currency,
              provider: PaymentProvider.STRIPE,
            },
          },
          update: { providerPriceId: price.id, price: optionSeed.price, isActive: true },
          create: {
            planId: plan.id,
            productId: product.id,
            billingCycleId: billingCycle.id,
            name: `${planSeed.name} ${optionSeed.cycleName}`,
            price: optionSeed.price,
            currency: optionSeed.currency,
            provider: PaymentProvider.STRIPE,
            providerPriceId: price.id,
          },
        });
      }
    }
  }

  // Nghiệm thu chính của C3, kiểm ngay tại đây thay vì để user phát hiện lúc đăng ký.
  // Đọc y hệt StripeService.getFreePriceId() — nếu đây null thì free plan flow chết.
  const freePlan = await prisma.plan.findFirst({
    where: { code: 'FREE' },
    include: { pricingOptions: true },
  });
  const freePriceId = freePlan?.pricingOptions[0]?.providerPriceId ?? null;
  if (!freePriceId) {
    throw new Error('Seed xong nhưng free plan vẫn không có providerPriceId.');
  }
  console.log(`\ngetFreePriceId() -> ${freePriceId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/*
 * HAI THỨ SEED NÀY ĐANG PHẢI NÉ, KHÔNG PHẢI CHỌN CHO ĐẸP:
 *
 * 1. StripeService.getFreePriceId() (src/stripe — Dev B) tra `plan.findFirst({ code:'FREE' })`
 *    KHÔNG kèm productId, rồi lấy `pricingOptions[0]`. Nhưng Plan.code là
 *    @@unique([productId, code]) — FREE tồn tại theo TỪNG product. Nên seed product thứ hai
 *    có plan FREE là hàm đó thành tung đồng xu, và user rơi vào free plan của sai product.
 *    Vì vậy CATALOG ở trên cố ý chỉ có một product. Sửa thật thuộc về Dev B: hàm cần nhận
 *    productId. Đây là chặn, không phải ý thích.
 *
 * 2. BillingCycle chưa có @@unique([name, durationDay]) nên không upsert được — phải
 *    findFirst rồi mới create, tức có khe đua nếu hai seed chạy song song. Với seed dev thì
 *    chấp nhận được, nhưng ràng buộc nên vào schema (schema đang đóng băng sau PR1).
 */
