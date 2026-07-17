-- DropIndex
DROP INDEX "Subscription_userId_key";

-- AlterTable
ALTER TABLE "AddonPackage" ADD COLUMN     "productId" TEXT;

-- AddForeignKey
ALTER TABLE "AddonPackage" ADD CONSTRAINT "AddonPackage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
