-- CreateEnum
CREATE TYPE "CreditGrantSourceType" AS ENUM ('SUBSCRIPTION', 'ADDON', 'GIFT', 'PROMOTION', 'ADMIN');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('PROVIDER', 'MANUAL', 'NONE');

-- DropForeignKey
ALTER TABLE "PricingOption" DROP CONSTRAINT "PricingOption_planId_fkey";

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "grantId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "pricingOptionId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "addonRequiresLiveSubscription" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "billingMode" "BillingMode" NOT NULL DEFAULT 'PROVIDER',
ADD COLUMN     "productId" TEXT,
ALTER COLUMN "subscriptionCreditsRemaining" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceType" "CreditGrantSourceType" NOT NULL,
    "sourceRef" TEXT,
    "amountGranted" INTEGER NOT NULL,
    "amountRemaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditGrant_userId_productId_idx" ON "CreditGrant"("userId", "productId");

-- CreateIndex
CREATE INDEX "CreditTransaction_grantId_idx" ON "CreditTransaction"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_id_productId_key" ON "Plan"("id", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key" ON "Subscription"("provider", "providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "PricingOption" ADD CONSTRAINT "PricingOption_planId_productId_fkey" FOREIGN KEY ("planId", "productId") REFERENCES "Plan"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_pricingOptionId_fkey" FOREIGN KEY ("pricingOptionId") REFERENCES "PricingOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "CreditGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Constraint mà Prisma schema DSL không diễn đạt được (CHECK, partial unique index).
--
-- Đặt TRONG migration chứ không để file .sql rời: file rời nằm ngoài schema nên bất kỳ
-- lần drop/recreate cột nào cũng cuốn theo constraint mà không gì dựng lại, và
-- `migrate reset` thì không replay nó. Nằm ở đây thì reset replay đầy đủ.
-- ─────────────────────────────────────────────────────────────────────────────

-- §13.1 — Một sub live per user per product.
-- Live-set chỉ gồm ACTIVE + PAST_DUE: INCOMPLETE không bao giờ ghi local (row chỉ tạo khi
-- invoice.paid đầu tiên), TRIALING bỏ theo D12, PAUSED không thuộc live-set.
--
-- LƯU Ý: Subscription.productId còn nullable và chưa backfill; Postgres coi NULL là distinct
-- nên index này hiện TRƠ. Nó bắt đầu có hiệu lực khi PR3 (Dev B) populate productId.
CREATE UNIQUE INDEX "Subscription_live_user_product_key"
  ON "Subscription" ("userId", "productId")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE');

-- §13.2 — Không âm credit (tuyến phòng thủ cuối sau lock logic).
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_amount_nonneg_check"
  CHECK ("amountRemaining" >= 0 AND "amountRemaining" <= "amountGranted");

-- §13.5 — Grant từ subscription phải truy được về sub sinh ra nó.
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_source_ref_check"
  CHECK ("sourceType" <> 'SUBSCRIPTION' OR "sourceRef" IS NOT NULL);

-- §13.4 — billingMode nhất quán: PROVIDER ⇔ có Stripe sub phía sau.
-- Row Free (NONE) và Enterprise (MANUAL) thì không có providerSubscriptionId.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_billing_mode_check"
  CHECK (("billingMode" = 'PROVIDER') = ("providerSubscriptionId" IS NOT NULL));
