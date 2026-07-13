-- 1. Thêm cột UUID mới tạm thời
ALTER TABLE "User" ADD COLUMN "new_id" UUID;
ALTER TABLE "Subscription" ADD COLUMN "new_userId" UUID;
ALTER TABLE "CreditWallet" ADD COLUMN "new_userId" UUID;
ALTER TABLE "Payment" ADD COLUMN "new_userId" UUID;
ALTER TABLE "PaymentMethod" ADD COLUMN "new_userId" UUID;
ALTER TABLE "CreditTransaction" ADD COLUMN "new_userId" UUID;

-- 2. Sinh UUID cho toàn bộ User đang có
UPDATE "User" SET "new_id" = gen_random_uuid();
ALTER TABLE "User" ALTER COLUMN "new_id" SET NOT NULL;

-- 3. Copy liên kết UUID sang các bảng chứa khóa ngoại (Dựa vào ID cũ)
UPDATE "Subscription" SET "new_userId" = "User"."new_id" FROM "User" WHERE "Subscription"."userId" = "User"."id";
UPDATE "CreditWallet" SET "new_userId" = "User"."new_id" FROM "User" WHERE "CreditWallet"."userId" = "User"."id";
UPDATE "Payment" SET "new_userId" = "User"."new_id" FROM "User" WHERE "Payment"."userId" = "User"."id";
UPDATE "PaymentMethod" SET "new_userId" = "User"."new_id" FROM "User" WHERE "PaymentMethod"."userId" = "User"."id";
UPDATE "CreditTransaction" SET "new_userId" = "User"."new_id" FROM "User" WHERE "CreditTransaction"."userId" = "User"."id";

-- 4. Xóa các khóa ngoại (Foreign Keys) cũ
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey";
ALTER TABLE "CreditWallet" DROP CONSTRAINT "CreditWallet_userId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_userId_fkey";
ALTER TABLE "PaymentMethod" DROP CONSTRAINT "PaymentMethod_userId_fkey";
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_userId_fkey";

-- 5. Xóa khóa chính (Primary Keys) cũ
ALTER TABLE "CreditWallet" DROP CONSTRAINT "CreditWallet_pkey";
ALTER TABLE "User" DROP CONSTRAINT "User_pkey" CASCADE;

-- 6. Xóa các cột ID nguyên thủy (Int) cũ
ALTER TABLE "User" DROP COLUMN "id";
ALTER TABLE "Subscription" DROP COLUMN "userId";
ALTER TABLE "CreditWallet" DROP COLUMN "userId";
ALTER TABLE "Payment" DROP COLUMN "userId";
ALTER TABLE "PaymentMethod" DROP COLUMN "userId";
ALTER TABLE "CreditTransaction" DROP COLUMN "userId";

-- 7. Đổi tên cột mới để thay thế vị trí của cột cũ
ALTER TABLE "User" RENAME COLUMN "new_id" TO "id";
ALTER TABLE "Subscription" RENAME COLUMN "new_userId" TO "userId";
ALTER TABLE "CreditWallet" RENAME COLUMN "new_userId" TO "userId";
ALTER TABLE "Payment" RENAME COLUMN "new_userId" TO "userId";
ALTER TABLE "PaymentMethod" RENAME COLUMN "new_userId" TO "userId";
ALTER TABLE "CreditTransaction" RENAME COLUMN "new_userId" TO "userId";

-- 8. Gắn lại Primary Key mới (UUID)
ALTER TABLE "User" ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_pkey" PRIMARY KEY ("userId");

-- Đảm bảo dữ liệu không null
ALTER TABLE "Subscription" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "CreditWallet" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "PaymentMethod" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "CreditTransaction" ALTER COLUMN "userId" SET NOT NULL;

-- 9. Tạo Unique Index cho những chỗ bị mất (ví dụ userId của Subscription)
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- 10. Gắn lại khóa ngoại mới (Lưu ý kiểu của id chuyển sang dạng VARCHAR trong Prisma String cho tương thích hoặc giữ nguyên UUID tuỳ cơ chế, PostgreSQL tự ép kiểu)
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditWallet" ADD CONSTRAINT "CreditWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;