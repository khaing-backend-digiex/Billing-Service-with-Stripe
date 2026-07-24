-- PR4 — Xoá các cột/bảng đã chết theo §12 (Bước 2, Bước 3) và D12.
--
-- BỐI CẢNH: schema.prisma đánh dấu @deprecated ba thứ dưới đây từ PR2/PR3 với ghi chú
-- "giữ để branch luôn compile, xoá ở PR4". Đến giờ src/ đã sạch, nên xoá thật.
--
-- 1. Subscription.subscriptionCreditsRemaining (§12 Bước 3, §4)
--    Số dư credit đã dời sang CreditGrant từ PR2. Không còn src/ nào đọc hay ghi cột này —
--    grep chỉ ra fixture test và một check trong prisma/doctor.ts vốn tồn tại chỉ để cảnh
--    báo về chính cột này (checkStrandedSubscriptionCredits, xoá cùng migration này).
--    Giữ lại là để hệ thống có hai chỗ trả lời "user còn bao nhiêu credit" và một trong
--    hai luôn nói dối.
--
-- 2. Subscription.trialStart / trialEnd (D12 — "bỏ trial hoàn toàn")
--    Đây là đường ghi một chiều: Stripe trial_start/trial_end → stripe.adapter.mapSubscription
--    → PaymentSubscription → subscription-sync.syncFromStripe → ghi cột. KHÔNG có API, gate
--    hay cron nào đọc ra. D12 đã bỏ Stripe trial nên nguồn cũng luôn null. Toàn bộ chuỗi
--    ghi này bị gỡ trong cùng commit (payment.types.ts, stripe.adapter.ts,
--    subscription-sync.service.ts).
--    Enum SubscriptionStatus.TRIALING GIỮ NGUYÊN: nó vẫn nằm trong map trạng thái Stripe và
--    live-set của nhiều query; bỏ giá trị enum là thay đổi khác, không thuộc phạm vi ở đây.
--
-- 3. Bảng CreditWallet (§12 Bước 2 — "Xóa model CreditWallet khỏi schema", §9)
--    addonCredits là một số nguyên không nguồn gốc, không hạn dùng, không chiều product —
--    ba thứ CreditGrant sinh ra để thay. Không src/ nào đọc/ghi bảng này từ PR2.
--    "Wallet" giờ là khái niệm ĐỌC: SUM(amountRemaining) GROUP BY productId, sourceType.
--
-- MẤT DỮ LIỆU: có, và là chủ đích. Ba chỗ này chứa số dư của mô hình cũ; không backfill
-- sang CreditGrant vì chuyển số dư là quyết định business (xem doctor.ts trước khi xoá:
-- check cũ liệt kê đúng các row còn kẹt). Trên dev, data là mẫu → `npm run db:reset`.

-- DropForeignKey
ALTER TABLE "CreditWallet" DROP CONSTRAINT "CreditWallet_userId_fkey";

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "subscriptionCreditsRemaining",
DROP COLUMN "trialEnd",
DROP COLUMN "trialStart";

-- DropTable
DROP TABLE "CreditWallet";
