-- Constraint mà Prisma schema DSL không diễn đạt được (CHECK, partial unique index).
--
-- Chạy sau mỗi `prisma db push` — xem `npm run db:sync`. Đã verify: db push KHÔNG xoá
-- các constraint này kể cả khi nó ALTER TABLE trên chính bảng đó (Prisma chỉ quản những
-- gì có trong schema). Nhưng `db push --force-reset` / `migrate reset` thì xoá sạch,
-- nên đừng chạy tay — luôn đi qua `npm run db:sync`.
--
-- File phải idempotent: chạy lại nhiều lần không lỗi.

-- ─────────────────────────────────────────────────────────────────────────────
-- §13.1 — Một sub live per user per product
-- ─────────────────────────────────────────────────────────────────────────────
-- Live-set chỉ gồm ACTIVE + PAST_DUE: INCOMPLETE không bao giờ ghi local (row chỉ tạo
-- khi invoice.paid đầu tiên), TRIALING bỏ theo D12, PAUSED không nằm trong live-set.
--
-- LƯU Ý (PR1): Subscription.productId còn nullable và chưa backfill, mà Postgres coi NULL
-- là distinct → index này hiện TRƠ, chưa chặn gì. Nó bắt đầu có hiệu lực khi PR3 (Dev B)
-- populate productId. Tạo sẵn từ PR1 để PR3 không phải đụng file này.
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_live_user_product_key"
  ON "Subscription" ("userId", "productId")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE');

-- ─────────────────────────────────────────────────────────────────────────────
-- §13.2 — Không âm credit (tuyến phòng thủ cuối sau lock logic)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "CreditGrant" DROP CONSTRAINT IF EXISTS "CreditGrant_amount_nonneg_check";
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_amount_nonneg_check"
  CHECK ("amountRemaining" >= 0 AND "amountRemaining" <= "amountGranted");

-- ─────────────────────────────────────────────────────────────────────────────
-- §13.5 — Grant hợp lệ: grant từ subscription phải truy được về sub sinh ra nó
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "CreditGrant" DROP CONSTRAINT IF EXISTS "CreditGrant_source_ref_check";
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_source_ref_check"
  CHECK ("sourceType" <> 'SUBSCRIPTION' OR "sourceRef" IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- §13.4 — billingMode nhất quán với providerSubscriptionId
-- ─────────────────────────────────────────────────────────────────────────────
-- PROVIDER ⇔ có Stripe sub phía sau. Row Free (NONE) và Enterprise (MANUAL) thì không.
-- Verified: 0/107 row hiện có vi phạm (tất cả đều có providerSubscriptionId + default PROVIDER).
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "Subscription_billing_mode_check";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_billing_mode_check"
  CHECK (("billingMode" = 'PROVIDER') = ("providerSubscriptionId" IS NOT NULL));
