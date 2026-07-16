DO $$ BEGIN
    CREATE TYPE "ResetInterval" AS ENUM ('MONTHLY', 'EVERY_N_DAYS');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- DropIndex
DROP INDEX IF EXISTS "Plan_code_key";

-- CreateTable
CREATE TABLE IF NOT EXISTS "Product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- Insert Default Product (so we have an ID to reference for existing plans/options)
INSERT INTO "Product" ("id", "code", "name", "isActive", "updatedAt") 
VALUES ('prod_ai_default', 'AI', 'Artificial Intelligence', true, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- AlterTable
ALTER TABLE "PaymentMethod" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable: add columns as NULLable first
ALTER TABLE "Plan" ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "productId" TEXT;

ALTER TABLE "PricingOption" ADD COLUMN "productId" TEXT;

-- Update existing rows to reference the default product
UPDATE "Plan" SET "productId" = 'prod_ai_default' WHERE "productId" IS NULL;
UPDATE "PricingOption" SET "productId" = 'prod_ai_default' WHERE "productId" IS NULL;

-- AlterTable: make columns NOT NULL now that they have data
ALTER TABLE "Plan" ALTER COLUMN "productId" SET NOT NULL;
ALTER TABLE "PricingOption" ALTER COLUMN "productId" SET NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CreditPolicy" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "creditAmount" INTEGER NOT NULL,
    "resetInterval" "ResetInterval" NOT NULL,
    "intervalDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPolicy_pkey" PRIMARY KEY ("id")
);

-- Migrate existing Plan data to CreditPolicy
INSERT INTO "CreditPolicy" ("id", "planId", "creditAmount", "resetInterval", "intervalDays", "createdAt", "updatedAt")
SELECT 
    'policy_' || "id", 
    "id", 
    COALESCE("renewalCredits", 0), 
    CASE 
        WHEN "resetIntervalDay" % 30 = 0 THEN 'MONTHLY'::"ResetInterval" 
        ELSE 'EVERY_N_DAYS'::"ResetInterval" 
    END,
    CASE 
        WHEN "resetIntervalDay" % 30 = 0 THEN NULL
        ELSE "resetIntervalDay"
    END,
    CURRENT_TIMESTAMP, 
    CURRENT_TIMESTAMP
FROM "Plan"
ON CONFLICT DO NOTHING;

-- Drop old columns on Plan
ALTER TABLE "Plan" DROP COLUMN "renewalCredits",
DROP COLUMN "resetIntervalDay";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Product_code_key" ON "Product"("code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CreditPolicy_planId_key" ON "CreditPolicy"("planId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Plan_productId_code_key" ON "Plan"("productId", "code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PricingOption_planId_billingCycleId_currency_provider_key" ON "PricingOption"("planId", "billingCycleId", "currency", "provider");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PricingOption_provider_providerPriceId_key" ON "PricingOption"("provider", "providerPriceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PricingOption_id_productId_key" ON "PricingOption"("id", "productId");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPolicy" ADD CONSTRAINT "CreditPolicy_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
