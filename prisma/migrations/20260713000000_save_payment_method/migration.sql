-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'INCOMPLETE';

-- AlterEnum
ALTER TYPE "SubscriptionEventType" ADD VALUE 'PAYMENT_ACTION_REQUIRED';

-- AlterTable
ALTER TABLE "PaymentMethod" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "expMonth" INTEGER,
ADD COLUMN     "expYear" INTEGER,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "last4" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "isDefault" SET DEFAULT false;

-- DEFAULT chỉ cần để backfill các hàng đang có; Prisma tự set @updatedAt ở mọi lệnh ghi.
ALTER TABLE "PaymentMethod" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_providerPaymentMethodId_key" ON "PaymentMethod"("providerPaymentMethodId");

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_idx" ON "PaymentMethod"("userId");
