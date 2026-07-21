-- §13.1 — Backfill Subscription."productId" cho row lịch sử.
--
-- VÌ SAO CẦN: 20260717022353 đã `DROP INDEX "Subscription_userId_key"` — gỡ hàng rào cũ
-- "1 sub / user". Hàng rào mới là partial unique index "Subscription_live_user_product_key"
-- trên ("userId", "productId") WHERE status IN ('ACTIVE','PAST_DUE'). NULL là DISTINCT trong
-- unique index của Postgres, nên mọi row còn productId NULL đều lọt qua index đó: rào cũ đã
-- gỡ mà rào mới chưa chắn được gì. Đo trên dev trước khi viết: 92/104 ACTIVE + 11/11 PAST_DUE
-- còn NULL — tức invariant quan trọng nhất của multi-subscription đang không được enforce.
--
-- VÌ SAO LÀ MIGRATION, KHÔNG PHẢI SCRIPT RỜI: backfill này từng nằm ở scripts/migrate-step3.ts
-- (đã xoá cùng commit). Script rời phải nhớ chạy tay, và bằng chứng là không ai chạy — nó còn
-- dùng `new PrismaClient()` trần trong khi Prisma 7 bắt buộc truyền adapter, tức có gọi cũng
-- ném lỗi ngay ở constructor. Migration thì `migrate deploy`/`migrate dev` tự áp đúng một lần
-- lên mọi DB hiện có và ghi lại vào _prisma_migrations.
--
-- NGUỒN LÀ PricingOption."productId", KHÔNG PHẢI Plan."productId": đây đúng là cột mà FK kép
-- `Subscription(pricingOptionId, productId) → PricingOption(id, productId)` (§13.1, PR3 còn
-- thiếu) sẽ đối chiếu — backfill sai nguồn thì FK đó về sau không add nổi. Hai cột này vốn đã
-- được composite FK PricingOption→Plan giữ khớp (đã verify trên dev: 0 hàng lệch).
--
-- KHÔNG SIẾT NOT NULL ở đây: đó là PR4 (xem chú thích Subscription.productId trong schema).
-- Trên DB dựng mới migration này là no-op — bảng rỗng, và mọi write path đã set productId từ
-- 9d84f12. Nó chỉ để chữa row lịch sử.
--
-- Idempotent: chỉ đụng row NULL; chạy lại là no-op.

UPDATE "Subscription" s
SET "productId" = po."productId"
FROM "PricingOption" po
WHERE po."id" = s."pricingOptionId"
  AND s."productId" IS NULL;
