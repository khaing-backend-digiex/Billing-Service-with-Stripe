-- CreditGrant.sourceRef = ENTITY sinh ra grant. Invoice là EVENT, thuộc về sổ.
--
-- Trước migration này `invoice.paid` nhét invoice.id vào sourceRef (và vào
-- CreditTransaction.referenceId với referenceType = 'SUBSCRIPTION'), trong khi cron reset
-- nhét subscription.id. Cùng một cột, hai loại thực thể. Hệ quả: reconcile hỏi "sub này đã
-- được cấp credit cho kỳ hiện tại chưa" bằng cách so referenceId với subscription.id, nên
-- mọi sub settle qua invoice.paid đều vô hình với nó và bị coi là kẹt vĩnh viễn.
--
-- Viết tay chứ không để `prisma migrate dev` sinh: nó cast thẳng
-- `"sourceType"::text::"CreditGrantSourceType_new"`, mà 'SUBSCRIPTION' không có trong enum
-- mới nên cast nổ trên mọi DB đang có dữ liệu.

-- AlterEnum: SUBSCRIPTION tách thành ALLOCATION (cấp theo hoá đơn) và RESET (cron trong kỳ).
-- Hàng cũ map về ALLOCATION: đó là đường cấp chính (invoice.paid), và enum cũ không giữ lại
-- thông tin để phân biệt hai đường. Sai lệch còn lại chỉ ảnh hưởng phân loại báo cáo, không
-- ảnh hưởng số dư hay reconcile — cả hai giá trị đều neo sourceRef vào subscription.id.
BEGIN;
-- CreditGrant_source_ref_check (§13.5) so sourceType với literal của enum CŨ, nên nó chặn
-- ALTER TYPE: Postgres không có operator giữa enum mới và enum cũ. Drop trước, dựng lại sau
-- theo hai giá trị mới — invariant không đổi, chỉ tên giá trị đổi.
ALTER TABLE "CreditGrant" DROP CONSTRAINT "CreditGrant_source_ref_check";

CREATE TYPE "CreditGrantSourceType_new" AS ENUM ('SUBSCRIPTION_ALLOCATION', 'SUBSCRIPTION_RESET', 'ADDON', 'GIFT', 'PROMOTION', 'ADMIN');
ALTER TABLE "CreditGrant" ALTER COLUMN "sourceType" TYPE "CreditGrantSourceType_new"
  USING (
    CASE "sourceType"::text
      WHEN 'SUBSCRIPTION' THEN 'SUBSCRIPTION_ALLOCATION'
      ELSE "sourceType"::text
    END
  )::"CreditGrantSourceType_new";
ALTER TYPE "CreditGrantSourceType" RENAME TO "CreditGrantSourceType_old";
ALTER TYPE "CreditGrantSourceType_new" RENAME TO "CreditGrantSourceType";
DROP TYPE "public"."CreditGrantSourceType_old";

-- §13.5 — Grant từ subscription phải truy được về sub sinh ra nó. Giờ là hai sourceType.
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_source_ref_check"
  CHECK ("sourceType" NOT IN ('SUBSCRIPTION_ALLOCATION', 'SUBSCRIPTION_RESET') OR "sourceRef" IS NOT NULL);
COMMIT;

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "invoiceId" TEXT;

-- CreateIndex
CREATE INDEX "CreditTransaction_invoiceId_idx" ON "CreditTransaction"("invoiceId");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────── Backfill ───────────────────────────
-- Đưa hàng cũ về đúng định nghĩa. An toàn vì id là cuid: một sourceRef không thể vừa khớp
-- Invoice vừa khớp Subscription (đã kiểm trên dev: 176 khớp Subscription, 22 khớp Invoice,
-- 0 khớp cả hai). Hàng nào đã đúng thì JOIN không khớp nên không bị đụng tới.

-- Grant: sourceRef đang giữ invoice.id → đổi về subscription.id của chính hoá đơn đó.
UPDATE "CreditGrant" g
SET "sourceRef" = i."subscriptionId"
FROM "Invoice" i
WHERE g."sourceRef" = i."id"
  AND g."sourceType" IN ('SUBSCRIPTION_ALLOCATION', 'SUBSCRIPTION_RESET');

-- Transaction: referenceId đang giữ invoice.id → hoá đơn dời sang invoiceId (log), còn
-- referenceId trỏ về subscription.id cho đúng referenceType = 'SUBSCRIPTION'.
UPDATE "CreditTransaction" ct
SET "invoiceId" = i."id",
    "referenceId" = i."subscriptionId"
FROM "Invoice" i
WHERE ct."referenceId" = i."id"
  AND ct."referenceType" = 'SUBSCRIPTION';
