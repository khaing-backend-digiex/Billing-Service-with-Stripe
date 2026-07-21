import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PaymentProvider, PrismaClient, ResetInterval } from '@prisma/client';
import Stripe from 'stripe';
import { formatDatabaseAmountToStripe } from '../src/stripe/utils/stripe-currency.util';
import {
  RecurringSpec,
  adoptExistingPrice,
  ensureStripeProduct,
  ensureStripeRecurringPrice,
  stripePriceLookupKey,
  stripeProductId,
} from './stripe-catalog';

interface OptionSeed {
  cycleName: string;
  durationDay: number;
  currency: string;
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
const YEARLY: RecurringSpec = { interval: 'year', intervalCount: 1 };

const CATALOG: ProductSeed[] = [
  {
    code: 'AI',
    name: 'Artificial Intelligence',
    plans: [
      {
        code: 'FREE',
        name: 'Gói Free',
        isFree: true,
        creditAmount: 50,
        resetInterval: ResetInterval.MONTHLY,
        options: [
          {
            cycleName: 'MONTHLY',
            durationDay: 30,
            currency: 'vnd',
            price: 0,
            recurring: MONTHLY,
          },
        ],
      },
      {
        code: 'PRO',
        name: 'Gói Pro',
        isFree: false,
        creditAmount: 100,
        resetInterval: ResetInterval.MONTHLY,
        options: [
          {
            cycleName: 'MONTHLY',
            durationDay: 30,
            currency: 'vnd',
            price: 300_000,
            recurring: MONTHLY,
          },
          {
            cycleName: 'ANUALLY',
            durationDay: 365,
            currency: 'vnd',
            price: 3_000_000,
            recurring: YEARLY,
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

      let stripeProductIdCache: string | null = null;
      const productForPrice = async (): Promise<string> => {
        if (stripeProductIdCache) return stripeProductIdCache;
        const p = await ensureStripeProduct(
          stripe,
          stripeProductId(productSeed.code, planSeed.code),
          `${productSeed.name} - ${planSeed.name}`,
        );
        console.log(`    Stripe product ${p.id} (${p.created ? 'tạo mới' : 'tái dùng'})`);
        stripeProductIdCache = p.id;
        return p.id;
      };

      for (const optionSeed of planSeed.options) {
        const billingCycle = await ensureBillingCycle(optionSeed.cycleName, optionSeed.durationDay);
        const optionKey = {
          planId: plan.id,
          billingCycleId: billingCycle.id,
          currency: optionSeed.currency,
          provider: PaymentProvider.STRIPE,
        };
        const lookupKey = stripePriceLookupKey(
          productSeed.code,
          planSeed.code,
          optionSeed.cycleName,
          optionSeed.currency,
        );

        const existing = await prisma.pricingOption.findUnique({
          where: { planId_billingCycleId_currency_provider: optionKey },
        });
        let priceId: string | null = existing?.providerPriceId
          ? await adoptExistingPrice(stripe, existing.providerPriceId, lookupKey)
          : null;

        if (priceId) {
          console.log(`    Stripe price ${priceId} (nhận nuôi price DB đang dùng)`);
        } else {
          const created = await ensureStripeRecurringPrice(stripe, {
            productId: await productForPrice(),
            lookupKey,
            unitAmount: formatDatabaseAmountToStripe(optionSeed.price, optionSeed.currency),
            currency: optionSeed.currency,
            recurring: optionSeed.recurring,
          });
          priceId = created.id;
          console.log(`    Stripe price ${priceId} (${created.created ? 'tạo mới' : 'tái dùng'})`);
        }

        await prisma.pricingOption.upsert({
          where: { planId_billingCycleId_currency_provider: optionKey },
          update: { providerPriceId: priceId, isActive: true },
          create: {
            ...optionKey,
            productId: product.id,
            name: `${planSeed.name} ${optionSeed.cycleName}`,
            price: optionSeed.price,
            providerPriceId: priceId,
          },
        });
      }
    }
  }

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