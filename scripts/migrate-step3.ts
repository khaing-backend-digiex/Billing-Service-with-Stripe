import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting Step 3 Data Backfill...');

  // 1. Backfill Subscription productId
  const subscriptions = await prisma.subscription.findMany({
    where: { productId: null },
    include: {
      pricingOption: {
        include: { plan: true }
      }
    }
  });

  console.log(`Found ${subscriptions.length} subscriptions missing productId.`);

  for (const sub of subscriptions) {
    const productId = sub.pricingOption?.plan?.productId;
    if (productId) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { productId }
      });
      console.log(`Updated subscription ${sub.id} with productId ${productId}`);
    } else {
      console.warn(`Warning: Subscription ${sub.id} has no valid plan/productId`);
    }
  }

  // 2. Backfill AddonPackage productId
  const addons = await prisma.addonPackage.findMany({
    where: { productId: null }
  });

  console.log(`Found ${addons.length} addons missing productId.`);

  if (addons.length > 0) {
    const aiProduct = await prisma.product.findFirst({
      where: { code: 'AI' }
    });

    if (aiProduct) {
      for (const addon of addons) {
        await prisma.addonPackage.update({
          where: { id: addon.id },
          data: { productId: aiProduct.id }
        });
        console.log(`Updated addon ${addon.id} with productId ${aiProduct.id}`);
      }
    } else {
      console.error('Error: AI product not found. Cannot backfill addons.');
    }
  }

  console.log('Step 3 Data Backfill Completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
