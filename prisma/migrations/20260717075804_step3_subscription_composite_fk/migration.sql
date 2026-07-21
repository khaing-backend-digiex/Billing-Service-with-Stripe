-- §13.1 — Chốt nốt phần denormalize productId: NOT NULL + FK kép.
--
-- BỐI CẢNH: 20260717022353 gỡ "Subscription_userId_key" (rào cũ "1 sub/user"), rào mới là
-- partial unique index "Subscription_live_user_product_key" trên ("userId","productId").
-- 20260717040000 đã backfill 108 row NULL → 0. Migration này khoá lại để NULL không quay về.
--
-- VÌ SAO NOT NULL (§13.1, vốn xếp cho PR4 — kéo lên đây vì FK kép không tách rời được):
--   1. NULL là DISTINCT trong unique index của Postgres → row NULL lọt qua partial unique
--      index, rào mới thành hình thức. Đây đúng là cái đã xảy ra: 92/104 ACTIVE từng NULL.
--   2. FK kép dưới đây mặc định là MATCH SIMPLE: chỉ cần MỘT cột NULL là bỏ qua kiểm tra
--      cả bộ. Để productId nullable thì FK vừa thêm cũng né đúng đám row đáng ngờ nhất.
-- An toàn tại thời điểm chạy: đã verify 0 NULL, và mọi write path set productId từ 9d84f12.
--
-- VÌ SAO ĐỔI FK ĐƠN → FK KÉP: FK đơn chỉ buộc pricingOptionId có thật, để productId trôi tự
-- do khỏi pricingOption.plan.productId — nghĩa là cột chống lưng cho unique index §13.1 được
-- phép nói dối, và invariant "1 sub live/user/product" enforce trên dữ liệu sai. FK kép khiến
-- lệch là bất khả ở tầng DB. Cùng pattern PricingOption→Plan (20260716020000).
-- Neo tham chiếu unique "PricingOption_id_productId_key" đã có sẵn từ step1.
-- Verify trước khi chạy: 0 hàng Subscription.productId lệch PricingOption.productId.
--
-- FK đơn bị drop chứ không giữ song song: khi productId đã NOT NULL thì FK kép bao trọn
-- pricingOptionId, giữ thêm FK đơn chỉ là index thừa.

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_pricingOptionId_fkey";

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "productId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pricingOptionId_productId_fkey" FOREIGN KEY ("pricingOptionId", "productId") REFERENCES "PricingOption"("id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;
