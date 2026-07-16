import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  
  try {
    // Check if CreditGrantSourceType enum exists, create it if not
    try {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditGrantSourceType') THEN
            CREATE TYPE "CreditGrantSourceType" AS ENUM ('SUBSCRIPTION', 'ADDON', 'GIFT', 'PROMOTION', 'ADMIN');
          END IF;
        END
        $$;
      `);
      console.log('Ensured CreditGrantSourceType enum exists.');
    } catch (e) {
      console.log('Error with enum:', e);
    }

    // Check if CreditGrant exists, create if not
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "CreditGrant" (
          "id" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "productId" TEXT NOT NULL,
          "sourceType" "CreditGrantSourceType" NOT NULL,
          "sourceRef" TEXT,
          "amountGranted" INTEGER NOT NULL,
          "amountRemaining" INTEGER NOT NULL,
          "expiresAt" TIMESTAMP(3),
          "priority" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
        );
      `);
      console.log('Ensured CreditGrant table exists.');
    } catch (e) {
      console.log('Error creating CreditGrant:', e);
    }
    
    // Check if CreditWallet still exists, if so migrate
    const hasWallet = await prisma.$queryRawUnsafe(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'CreditWallet'
      );
    `);
    if ((hasWallet as any)[0].exists) {
      console.log('Migrating CreditWallet data...');
      await prisma.$executeRawUnsafe(`
        INSERT INTO "CreditGrant" (
          "id", "userId", "productId", "sourceType", "amountGranted", "amountRemaining", "priority", "createdAt", "updatedAt"
        )
        SELECT 
          gen_random_uuid()::text, "userId", (SELECT "id" FROM "Product" LIMIT 1), 'ADDON'::"CreditGrantSourceType", "addonCredits", "addonCredits", 100, NOW(), NOW()
        FROM "CreditWallet"
        WHERE "addonCredits" > 0;
      `);
      console.log('Migrated CreditWallet data to CreditGrant.');
    } else {
      console.log('CreditWallet table does not exist, skipping...');
    }

    // Check if Subscription still has subscriptionCreditsRemaining
    const hasSubCredits = await prisma.$queryRawUnsafe(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'Subscription'
        AND column_name = 'subscriptionCreditsRemaining'
      );
    `);
    
    if ((hasSubCredits as any)[0].exists) {
      console.log('Migrating subscriptionCreditsRemaining data...');
      
      // Need to find productId for subscriptions. If Subscription.productId exists, use it, else fallback to Product AI
      const hasProductId = await prisma.$queryRawUnsafe(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_schema = 'public' 
          AND table_name = 'Subscription'
          AND column_name = 'productId'
        );
      `);
      
      let productIdSql = `(SELECT "id" FROM "Product" LIMIT 1)`;
      if ((hasProductId as any)[0].exists) {
         productIdSql = `COALESCE("productId", (SELECT "id" FROM "Product" LIMIT 1))`;
      }
      
      await prisma.$executeRawUnsafe(`
        INSERT INTO "CreditGrant" (
          "id", "userId", "productId", "sourceType", "sourceRef", "amountGranted", "amountRemaining", "expiresAt", "priority", "createdAt", "updatedAt"
        )
        SELECT 
          gen_random_uuid()::text, "userId", ${productIdSql}, 'SUBSCRIPTION'::"CreditGrantSourceType", "id", "subscriptionCreditsRemaining", "subscriptionCreditsRemaining", "nextCreditResetAt", 10, NOW(), NOW()
        FROM "Subscription"
        WHERE "subscriptionCreditsRemaining" > 0;
      `);
      console.log('Migrated subscriptionCreditsRemaining data to CreditGrant.');
    } else {
      console.log('Subscription.subscriptionCreditsRemaining column does not exist, skipping...');
    }
    
    console.log('Data migration complete.');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
