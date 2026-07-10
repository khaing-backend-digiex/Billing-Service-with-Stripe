# Billing Service — Luồng nghiệp vụ end-to-end

Tài liệu mô tả toàn bộ business flow của hệ thống **chỉ bằng các API hiện có**. Không đề xuất API mới.

Với mỗi flow: API được gọi, ý nghĩa từng field request, response success/error, API gọi tiếp theo, luồng `Client → Controller → Service → DB/Stripe → Webhook → Response`, các điều kiện kiểm tra, nhánh xử lý (success/fail/retry/idempotency) và edge case.

Ngày cập nhật: 2026-07-09 · Nhánh: `dev`

---

## Mục lục

- [Bảng API hiện có](#bảng-api-hiện-có)
- [Flow 1 — Khởi tạo catalog (Admin)](#flow-1--khởi-tạo-catalog-admin-chạy-một-lần)
- [Flow 2 — Đăng ký user (onboarding + auto free plan)](#flow-2--đăng-ký-user-onboarding--auto-free-plan)
- [Flow 3 — Đăng nhập](#flow-3--đăng-nhập)
- [Flow 4 — Xem bảng giá](#flow-4--xem-bảng-giá-public)
- [Flow 5 — Mua gói trả phí / Nâng cấp từ Free](#flow-5--mua-gói-trả-phí--nâng-cấp-từ-free)
- [Flow 6 — Mua Addon credits](#flow-6--mua-addon-credits)
- [Flow 7 — Xem lịch sử thanh toán](#flow-7--xem-lịch-sử-thanh-toán)
- [Flow 8 — Đổi gói và quản lý thẻ (Billing Portal)](#flow-8--đổi-gói-và-quản-lý-thẻ-qua-billing-portal)
- [Flow 9 — Hủy gói ở cuối kỳ](#flow-9--hủy-gói-ở-cuối-kỳ)
- [Flow 10 — Thanh toán gia hạn thất bại](#flow-10--thanh-toán-gia-hạn-thất-bại)
- [Flow 11 — POST /stripe/payment-intent (không nên dùng)](#flow-11--post-stripepayment-intent-không-nên-dùng)
- [Flow 12 — Admin](#flow-12--admin)
- [Cron](#cron--không-có-api-nhưng-ảnh-hưởng-mọi-flow)
- [Điều không làm được bằng API hiện tại](#điều-thực-sự-không-làm-được-bằng-api-hiện-tại)
- [Ba vấn đề chặn đường](#ba-vấn-đề-chặn-đường-xếp-theo-mức-độ)

---

## Tóm tắt

Bộ API hiện tại **đủ để chạy trọn vòng đời billing** — onboarding → mua gói → mua addon → đổi gói → hủy → thất bại thanh toán → khôi phục — với điều kiện chấp nhận **Stripe Billing Portal làm mặt tiền cho đổi gói và hủy gói**.

Hai thứ không thể làm được bằng API hiện tại: **tiêu credit** và **đọc trạng thái subscription/số dư credit**. Chi tiết ở [cuối tài liệu](#điều-thực-sự-không-làm-được-bằng-api-hiện-tại).

---

## Bảng API hiện có

| Method | Endpoint | Auth |
|---|---|---|
| POST | `/auth/register` | Public |
| POST | `/auth/login` | Public |
| GET | `/pricing/plans` | Public |
| GET | `/pricing/addons` | Public |
| POST | `/pricing/billing-cycles` | ADMIN |
| POST | `/pricing/plans` | ADMIN |
| POST | `/pricing/options` | ADMIN |
| POST | `/pricing/addons` | ADMIN |
| POST | `/stripe/customers` | ADMIN |
| POST | `/stripe/checkout/subscription` | JWT |
| POST | `/stripe/checkout/addon` | JWT |
| POST | `/stripe/payment-intent` | JWT |
| POST | `/stripe/billing-portal` | JWT |
| GET | `/stripe/payments` | JWT |
| POST | `/payments/cancel-subscription` | JWT |
| POST | `/stripe/webhook` | Public (Stripe signature) |
| GET | `/users` · GET `/users/:id` · DELETE `/users/:id` | ADMIN / JWT |
| GET | `/health` | Public |

**Envelope thành công** — [api-response.dto.ts](../src/common/dto/api-response.dto.ts):

```json
{ "statusCode": 200, "message": "...", "data": {} }
```

**Envelope lỗi** — [http-exception.filter.ts:54](../src/common/exceptions/http-exception.filter.ts#L54):

```json
{ "statusCode": 400, "message": "...", "data": null, "timestamp": "...", "path": "/..." }
```

> ⚠️ Ngoại lệ: toàn bộ [pricing.controller.ts](../src/pricing/pricing.controller.ts) trả **thẳng object Prisma**, không bọc envelope. Frontend phải xử lý hai dạng response khác nhau.

---

## Flow 1 — Khởi tạo catalog (Admin, chạy một lần)

Tiền đề cho mọi flow khác. Nếu bỏ qua, `getFreePriceId()` trả `null` và onboarding im lặng không tạo subscription.

Thứ tự bắt buộc: `billing-cycles` → `plans` → `options` → `addons`. Không thể đảo, vì `options` cần cả `planId` lẫn `billingCycleId`.

### 1.1 · `POST /pricing/billing-cycles`

```json
{ "name": "Monthly", "durationDay": 30 }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `name` | ✅ | Nhãn hiển thị |
| `durationDay` | ✅ | **Quyết định `interval` của Stripe Price** ở bước 1.3 |

Ánh xạ `durationDay` → Stripe interval, tại [pricing.service.ts:41-50](../src/pricing/pricing.service.ts#L41-L50):

| `durationDay` | interval | interval_count |
|---|---|---|
| 365 hoặc 366 | `year` | 1 |
| chia hết 30 | `month` | `durationDay / 30` |
| chia hết 7 | `week` | `durationDay / 7` |
| còn lại | `day` | `durationDay` |

Không gọi Stripe ở bước này. Response: object `BillingCycle` thô.

### 1.2 · `POST /pricing/plans`

```json
{ "code": "FREE", "name": "Free", "renewalCredits": 100, "resetIntervalDay": 30 }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `code` | ✅ | **Phải đúng chuỗi `"FREE"`** cho gói miễn phí |
| `name` | ✅ | Tên hiển thị |
| `renewalCredits` | ✅ | Số credit cấp mỗi chu kỳ |
| `resetIntervalDay` | ✅ | Quy đổi sang tháng: `Math.max(1, Math.round(resetIntervalDay / 30))` |

`StripeAdapter.getFreePriceId()` tra cứu `plan.findUnique({ where: { code: PLAN_CODES.FREE } })` — [stripe.adapter.ts:67](../src/stripe/adapter/stripe.adapter.ts#L67).

> 🔴 **Edge case:** sai chính tả `code` → toàn bộ onboarding và downgrade ngừng hoạt động, **không có lỗi nào được ném ra**, chỉ một dòng `logger.warn`.

`resetIntervalDay = 45` → 2 tháng. `= 20` → 1 tháng.

Không gọi Stripe. `code` là `@unique` → tạo trùng ném P2002 → filter trả **500**, không phải 409.

### 1.3 · `POST /pricing/options`

```json
{ "planId": "...", "billingCycleId": "...", "name": "Free", "price": 0, "currency": "usd" }
```

**Luồng:**

```
Controller → PricingService.createPricingOption
  ├─ plan = findUnique(planId)            → không thấy → throw new Error
  ├─ billingCycle = findUnique(cycleId)   → không thấy → throw new Error
  ├─ stripe.products.create()             [Stripe]
  ├─ stripe.prices.create({ recurring })  [Stripe]
  └─ prisma.pricingOption.create()        [DB]
```

**Nhánh lỗi:** cả ba lỗi trên bị `catch` chung và biến thành `InternalServerErrorException("Failed to create pricing option with Stripe")` — [pricing.service.ts:77-80](../src/pricing/pricing.service.ts#L77-L80). "Plan not found" trả về **500** với message nói về Stripe. Không phân biệt được lỗi input và lỗi Stripe.

> 🔴 **Edge case — rò rỉ tài nguyên Stripe:** ba lời gọi Stripe + DB **không nằm trong transaction**. Nếu `prisma.pricingOption.create` fail sau khi Stripe đã tạo Product + Price, chúng mồ côi trên Stripe vĩnh viễn. `CleanupTask` chỉ hỗ trợ `type: STRIPE_CUSTOMER`, không có loại nào cho Price.

> 🟡 **Edge case — gói FREE không xác định:** nếu tạo **nhiều** `PricingOption` cho plan `FREE`, `getFreePriceId()` lấy `pricingOptions[0]` mà Prisma không đảm bảo thứ tự khi không có `orderBy`. Gói free được chọn trở nên không xác định giữa các lần deploy.

### 1.4 · `POST /pricing/addons`

```json
{ "code": "CREDITS_1000", "name": "1000 Credits", "credits": 1000, "price": 10, "currency": "usd" }
```

Tạo Stripe Price **one-time** (không có `recurring`) → đúng cho `mode: "payment"` ở [Flow 6](#flow-6--mua-addon-credits). Cùng rủi ro mồ côi như 1.3.

---

## Flow 2 — Đăng ký user (onboarding + auto free plan)

Flow phức tạp nhất hệ thống: **đồng bộ với Stripe ngay trong request** và có rollback.

### `POST /auth/register`

```json
{ "name": "John Doe", "email": "john@example.com", "dateOfBirth": "1990-01-15" }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `name` | ✅ | `@IsNotEmpty()` |
| `email` | ✅ | `@IsEmail()`, unique ở DB |
| `dateOfBirth` | ❌ | **Được validate rồi bị vứt đi** |

> 🟡 `AuthService.register` chỉ destructure `{ email, name }` và gọi `createUser(email, name)` — [auth.service.ts:41](../src/auth/auth.service.ts#L41). Cột `User.dateOfBirth` tồn tại trong schema và luôn `null`. Client gửi lên không báo lỗi, chỉ đơn giản là không có tác dụng.

### Luồng end-to-end

```
Client
  → AuthController.register
  → AuthService.register
      ├─ usersService.findByEmail() → nếu tồn tại → 400 "Email already exists."
      └─ usersService.createUser()
          └─ provisionUser()
              ├─ prisma.user.create()                     [DB]  roles mặc định ["user"]
              └─ initializeUser() → ensureStripeSetup()
                  ├─ ensureStripeCustomerId()
                  │     ├─ stripe.customers.create()      [Stripe]
                  │     └─ prisma.user.update(providerCustomerId)  [DB]
                  └─ stripe.ensureFreeSubscription(customerId)
                        ├─ getFreePriceId()               [DB]
                        ├─ findActiveSubscription()       [Stripe]
                        └─ subscriptions.create()         [Stripe]
  ← 201 { statusCode, message, data: { name, email, roles } }
```

Sau đó, **bất đồng bộ**, Stripe bắn về:

```
customer.subscription.created       → không có strategy → WebhookEvent.status = UNHANDLED
invoice.created / invoice.finalized → UNHANDLED

invoice.paid ($0)                   → InvoicePaidStrategy
                                       ├─ subscription.upsert (tạo row local)
                                       └─ PaidInvoiceSyncService.applyPaidInvoice()
                                            → Invoice PAID
                                            → credits = renewalCredits
                                            → SubscriptionEvent CREATED
```

> 🔴 **Hàng `Subscription` local chỉ ra đời khi `invoice.paid` tới.** Không có strategy nào nghe `customer.subscription.created` — [stripe.module.ts:46-52](../src/stripe/stripe.module.ts#L46-L52) chỉ đăng ký 5 strategy. Giữa lúc `POST /auth/register` trả 201 và lúc webhook tới, user tồn tại nhưng **chưa có gói**.

### Nhánh lỗi và rollback

| Điểm hỏng | Hành vi |
|---|---|
| `stripe.customers.create` fail | `provisionUser` catch → `rollbackProvisionedUser` → xóa user row → ném lỗi → **500** |
| `prisma.user.update(providerCustomerId)` fail | `cleanupStripeCustomer` → `deleteCustomer`. Nếu delete cũng fail → `CleanupTask.upsert(STRIPE_CUSTOMER, PENDING)` → cron dọn sau |
| `ensureFreeSubscription` fail | `InternalServerErrorException` → rollback xóa cả Stripe customer lẫn user row → **500** |
| Plan `FREE` chưa tồn tại | `getFreePriceId()` trả `null` → `logger.warn` → **trả về `null`, không ném lỗi** → register **thành công 201**, user không có subscription. `FreePlanReconciliationCron` cũng sẽ skip. |

> 🔴 Nhánh cuối là edge case đáng lo nhất: hệ thống báo thành công nhưng user ở trạng thái không có gói, và **không có cơ chế nào tự sửa**.

### Idempotency

**Không có.** Bảo vệ duy nhất là `User.email @unique`.

> 🟡 **Race condition:** nếu request đầu đang ở giữa `stripe.customers.create` (chưa rollback), request retry thứ hai thấy user row và trả 400 "Email already exists". Sau đó request đầu rollback xóa user. Kết quả: **user không tồn tại, nhưng client đã nhận 400 "email đã tồn tại"**. Cửa sổ hẹp nhưng có thật.

### API gọi tiếp theo

`POST /auth/register` **không trả `accessToken`**. Frontend bắt buộc gọi [`POST /auth/login`](#flow-3--đăng-nhập) ngay sau đó.

---

## Flow 3 — Đăng nhập

### `POST /auth/login`

```json
{ "email": "john@example.com" }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `email` | ✅ | **Chỉ có vậy.** Không password, không OTP |

**Luồng:** `findByEmail` → không thấy → 400 `"User not found."` → thấy → `jwtService.sign({ sub, email, roles })`.

**Response 200:**

```json
{
  "statusCode": 200,
  "message": "User logged in successfully",
  "data": {
    "accessToken": "eyJ...",
    "user": { "email": "...", "name": "...", "roles": ["user"] }
  }
}
```

> 🔴 **Điều kiện cần kiểm tra mà hiện tại không có:** bất kỳ ai biết email của một user đều lấy được JWT hợp lệ của user đó, **bao gồm email admin**. `UsersService.onApplicationBootstrap` tạo sẵn một admin — [users.service.ts:52](../src/users/users.service.ts#L52). Đây là backdoor xác thực, không phải edge case.

Mọi request sau dùng header `Authorization: Bearer <accessToken>`. [`JwtStrategy.validate`](../src/auth/strategies/jwt.strategy.ts#L30) load lại user từ DB mỗi request, nên user bị xóa sau khi cấp token sẽ nhận 401.

---

## Flow 4 — Xem bảng giá (Public)

### `GET /pricing/plans`

Không body, không auth. Trả **mảng Prisma thô**, không bọc envelope:

```json
[
  {
    "id": "clx...", "code": "PRO", "name": "Pro",
    "renewalCredits": 1000, "resetIntervalDay": 30, "isActive": true,
    "pricingOptions": [
      {
        "id": "clp...", "name": "Pro Monthly",
        "price": "10", "currency": "usd",
        "providerPriceId": "price_...", "isActive": true
      }
    ]
  }
]
```

- `price` là `Decimal` → serialize thành **string**, không phải number. Frontend phải parse.
- 🟡 **Trả về cả plan và pricingOption có `isActive: false`.** Không có `where` filter nào trong [`getPlans()`](../src/pricing/pricing.service.ts#L22). Frontend phải tự lọc.
- 🟡 **Trả về cả plan `FREE`** kèm `pricingOptionId` của nó. Nếu frontend đưa id này vào [Flow 5](#flow-5--mua-gói-trả-phí--nâng-cấp-từ-free), sẽ tạo một subscription free thứ hai trên Stripe.

Frontend lấy `pricingOptions[].id` → đưa vào Flow 5.

### `GET /pricing/addons`

Tương tự, trả mảng `AddonPackage` thô. Lấy `id` → đưa vào [Flow 6](#flow-6--mua-addon-credits).

---

## Flow 5 — Mua gói trả phí / Nâng cấp từ Free

### `POST /stripe/checkout/subscription`

```json
{ "pricingOptionId": "clp..." }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `pricingOptionId` | ✅ | Id của `PricingOption` — **không phải** `planId`, **không phải** Stripe `price_id` |

Guard: `JwtAuthGuard` (global) → `RolesGuard` (không có `@Roles` ⇒ pass).

### Luồng xử lý trong controller

```
1. usersService.findById(userId)                            → không thấy → 404

2. prisma.subscription.findUnique({ userId })               [DB]
     ├─ có sub, status ∉ {CANCELLED, EXPIRED}, price > 0
     │     → 400 "Cannot create a new subscription checkout session
     │            while an active paid subscription exists."
     └─ ngược lại (free plan, hoặc đã hủy/hết hạn)          → đi tiếp

3. prisma.pricingOption.findUnique(dto.pricingOptionId)     [DB]
     └─ không thấy || !providerPriceId                      → 400

4. user.providerCustomerId ?? ensureStripeCustomerId(user)  [Stripe + DB]

5. stripeService.createCheckoutSession(userId, providerPriceId,
                                       "subscription", customerId)  [Stripe]

6. → 201 { statusCode: 201, message: "...", data: { url } }
```

Bước 2 là quy tắc business cốt lõi: **chỉ user đang ở gói giá 0 mới được checkout** — [stripe.controller.ts:87](../src/stripe/stripe.controller.ts#L87). Đây cũng là lý do "đổi gói trả phí → trả phí" phải đi qua [Billing Portal](#flow-8--đổi-gói-và-quản-lý-thẻ-qua-billing-portal).

### Điều kiện KHÔNG được kiểm tra

| Thiếu | Hậu quả |
|---|---|
| `pricingOption.isActive` | Mua được gói đã ngừng bán |
| `pricingOption.plan.code !== "FREE"` | Tạo **subscription free thứ hai** trên Stripe (`createCheckoutSession` không đi qua `ensureFreeSubscription` — hàm duy nhất có kiểm tra `findActiveSubscription`) |
| Price có phải recurring không | Truyền Price one-time → Stripe từ chối `mode: "subscription"` → lỗi thô |

### Sau khi nhận response

Frontend redirect trình duyệt tới `data.url`. **Không gọi API nào tiếp.**

`success_url` đã được adapter tự động chèn `?session_id={CHECKOUT_SESSION_ID}` — [stripe.adapter.ts:174](../src/stripe/adapter/stripe.adapter.ts#L174) — nhưng **không có endpoint nào nhận `session_id` để xác nhận**. Trang success chỉ có thể poll `GET /stripe/payments` cho tới khi thấy bản ghi mới.

### Chuỗi webhook sau khi user thanh toán

```
customer.subscription.created  → UNHANDLED

invoice.paid                   → InvoicePaidStrategy
  ├─ lấy line type="subscription" → stripeSubscriptionId
  ├─ user = findFirst({ providerCustomerId })       → null → log error, RETURN
  ├─ priceId ← line.pricing.price_details.price ?? line.price.id
  ├─ pricingOption = findByProviderPriceId(priceId) → null → log error, RETURN
  ├─ subscription.upsert({ where: { userId } })
  │     create: {...}   ← lần đầu
  │     update: {}      ← ⚠️ NO-OP nếu user đã có row (gói free)
  └─ paidInvoiceSync.applyPaidInvoice(invoice, subscription.id)
        └─ $transaction:
             invoice.updateMany(status ≠ PAID → PAID)   ← claim, idempotent
             count === 0 → skip toàn bộ
             payment.upsert(providerPaymentId)
             subscription.update({ status: ACTIVE,
                                   pricingOptionId ← gói MỚI,
                                   currentPeriod*, credits = renewalCredits })
             creditTransaction RENEWAL
             creditWallet.updateMany({ is_active: code !== "FREE" })
             subscriptionEvent CREATED | RENEWED

customer.subscription.updated  → CustomerSubscriptionUpdatedStrategy
  └─ subscriptionSyncService.syncFromStripe()
        ├─ subscription.upsert → providerSubscriptionId ← sub MỚI
        └─ nếu existing.providerSubscriptionId ≠ sub.id
              → stripe.cancelSubscriptionNow(sub_free_cũ)   [Stripe]

customer.subscription.deleted (sub free cũ) → CustomerSubscriptionDeletedStrategy
  └─ findFirst({ providerSubscriptionId: sub_free_cũ })
        → không thấy (row đã trỏ sub mới) → log error, RETURN   ✅ đúng
```

**Điểm tinh tế:** `invoice.paid` cập nhật `pricingOptionId` nhưng **không** cập nhật `providerSubscriptionId`. Trường đó chỉ được `syncFromStripe` đổi, vì `subscription.upsert` trong `InvoicePaidStrategy` dùng `update: {}` — [invoice-paid.strategy.ts:75](../src/stripe/webhook/strategies/invoice-paid.strategy.ts#L75).

### 🔴 Edge case: cửa sổ giữa `invoice.paid` và `customer.subscription.updated`

Nếu `invoice.paid` xử lý xong mà `customer.subscription.updated` chưa tới, hàng local ở trạng thái lai:

| Trường | Giá trị |
|---|---|
| `pricingOptionId` | PRO (mới) |
| `subscriptionCreditsRemaining` | 1000 (mới) |
| `providerSubscriptionId` | `sub_free_cũ` ⚠️ |

Nếu user bấm **Hủy gói** ([Flow 9](#flow-9--hủy-gói-ở-cuối-kỳ)) đúng lúc này, hệ thống gửi `cancel_at_period_end` cho **subscription free cũ**, không phải sub PRO vừa mua. **Sub PRO tiếp tục thu tiền.** Xác suất thấp, hậu quả tài chính.

### Idempotency — ba lớp, tất cả đã có

1. `WebhookEvent.id` là PK = `event.id` của Stripe → `claimEvent` chặn giao hàng trùng — [stripe-webhook.service.ts:63](../src/stripe/webhook/stripe-webhook.service.ts#L63).
2. `invoice.updateMany({ status: { not: PAID } })` + kiểm tra `count === 0` → chặn hai worker cùng xử lý.
3. `payment.upsert` theo `providerPaymentId @unique`.

Lớp 1 có nới lỏng: event ở trạng thái `RECEIVED` quá 10 phút (`STALE_CLAIM_MS`) sẽ bị re-claim, phòng worker chết giữa chừng. An toàn vì lớp 2 và 3 bảo vệ.

### 🔴 Nhánh im lặng cần biết

`InvoicePaidStrategy` `return` (không `throw`) trong 4 trường hợp: không có subscription trên invoice, không tìm thấy user, không có priceId, không tìm thấy pricingOption.

`StripeWebhookService` sau đó **mark event là `SUCCESS`** — [stripe-webhook.service.ts:35](../src/stripe/webhook/stripe-webhook.service.ts#L35). Nghĩa là: **tiền đã vào Stripe, credit không được cấp, và trong DB event ghi `SUCCESS`.** Không có cách nào phát hiện ngoài đọc log.

---

## Flow 6 — Mua Addon credits

### `POST /stripe/checkout/addon`

```json
{ "addonPackageId": "cla..." }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `addonPackageId` | ✅ | Id của `AddonPackage`, lấy từ `GET /pricing/addons` |

### Điều kiện kiểm tra

```
1. findById(userId)

2. subscription.findUnique({ userId }) include pricingOption.plan

3. isPaidPlanActive = sub != null
                   && sub.status === ACTIVE
                   && sub.pricingOption.plan.code !== "FREE"
   → false → 400 "You must have an active paid subscription to purchase addons."

4. addonPackage.findUnique(id) → !addon || !providerPriceId → 400

5. createCheckoutSession(userId, priceId, "payment", customerId, { addonPackageId })
```

> 🟡 Bước 3 dùng `=== ACTIVE` nghiêm ngặt: user đang `PAST_DUE` (trả tiền trễ) hoặc `TRIALING` **không mua được addon**. `TRIALING` bị chặn có thể là ngoài ý muốn.

Bước 5 là chỗ `mode: "payment"` phát huy: adapter set `payment_intent_data.metadata = { userId, addonPackageId }` — [stripe.adapter.ts:187-189](../src/stripe/adapter/stripe.adapter.ts#L187-L189). Metadata này chảy xuống PaymentIntent và **là toàn bộ cơ sở** để webhook biết đây là giao dịch addon.

### Chuỗi webhook

```
checkout.session.completed → UNHANDLED (không có strategy)

payment_intent.succeeded  → PaymentIntentSucceededStrategy
  ├─ metadata.addonPackageId & metadata.userId → thiếu 1 trong 2 → log, RETURN
  ├─ parseInt(userId) → NaN → log error, RETURN
  ├─ payment.findUnique(providerPaymentId)
  │     status === SUCCEEDED → RETURN               ← idempotency guard
  ├─ addonPackage.findUnique → null → log error, RETURN
  └─ $transaction:
       payment.upsert(SUCCEEDED, paidAt)
       creditWallet.upsert({ increment: addon.credits },
                            create: { addonCredits, is_active: true })
       creditTransaction ADDON_PURCHASE (referenceId = payment.id)
```

`creditWallet.upsert` là **nơi duy nhất trong toàn hệ thống tạo ra hàng `CreditWallet`**. Hệ quả: user chưa từng mua addon thì không có ví. Điều này giải thích tại sao `applyPaidInvoice` phải dùng `updateMany` rồi log "No credit wallet found" thay vì `update` — [paid-invoice-sync.service.ts:176-185](../src/stripe/sync/paid-invoice-sync.service.ts#L176-L185).

### Idempotency

Hai lớp: `WebhookEvent.id` PK, và `payment.findUnique().status === SUCCEEDED` → skip.

> 🟡 Lớp thứ hai có khe hở lý thuyết: hai worker cùng đọc `PENDING` trước khi ai kịp ghi `SUCCEEDED`, cả hai vào transaction, cả hai `increment` credit → **cộng credit hai lần**. `payment.upsert` không chặn được vì `increment` trên `creditWallet` là phép cộng, không phải phép gán. Lớp `claimEvent` mới là thứ thực sự chặn.

### Edge case

- 🔴 **Refund**: không có strategy `charge.refunded` → `Payment` vẫn `SUCCEEDED`, credit vẫn nằm trong ví. **Mua → nhận credit → refund → giữ credit.**
- 🟡 **Mất gói giữa chừng**: user mua addon lúc ACTIVE, gói bị hủy trước khi `payment_intent.succeeded` tới → credit vẫn được cộng vào ví (strategy không kiểm tra lại subscription). Đúng về kế toán, nhưng `creditWallet.is_active` sẽ bị `applyPaidInvoice` set `false` khi downgrade về free — [paid-invoice-sync.service.ts:178](../src/stripe/sync/paid-invoice-sync.service.ts#L178) → credit tồn tại nhưng ví "không active".

---

## Flow 7 — Xem lịch sử thanh toán

### `GET /stripe/payments`

Không query param, không body. Trả tất cả `Payment` của user, `orderBy: { createdAt: 'desc' }`, **không phân trang**.

```json
{
  "statusCode": 200,
  "message": "Payments fetched successfully",
  "data": [
    {
      "id": "...", "invoiceId": "...", "addonPackageId": null,
      "providerPaymentId": "pi_...", "amount": "10", "currency": "usd",
      "status": "SUCCEEDED", "paidAt": "2026-07-09T...", "createdAt": "..."
    }
  ]
}
```

- `amount` là `Decimal` → string.
- 🟡 Trả về **cả `Payment` status `PENDING` mắc kẹt** do [Flow 11](#flow-11--post-stripepayment-intent-không-nên-dùng) tạo ra.
- 🟡 Không có endpoint nào đọc `Invoice`, nên `invoiceId` trong response là id trơ, client không tra cứu được.

Đây là **API đọc duy nhất** mà user có.

---

## Flow 8 — Đổi gói và quản lý thẻ (qua Billing Portal)

Đây là câu trả lời cho "làm sao đổi gói mà không cần API mới".

### `POST /stripe/billing-portal`

Không có body (controller không nhận `@Body`).

```
1. findById(userId)
2. !user.providerCustomerId → 400 "User does not have a Stripe customer account."
3. stripe.billingPortal.sessions.create({ customer, return_url: STRIPE_SUCCESS_URL })
4. → 201 { data: { url } }
```

Frontend redirect tới `url`. Trong portal (tùy cấu hình ở Stripe Dashboard) user có thể: **đổi gói**, **hủy gói**, **đổi thẻ**, **xem hóa đơn**.

### Vì sao đổi gói qua portal hoạt động mà không cần code mới

Mọi thay đổi trong portal đều quay về qua webhook, và `SubscriptionSyncService.syncFromStripe` **đã xử lý sẵn việc đổi gói**:

```
customer.subscription.updated → syncFromStripe()
  ├─ pricingOption = findByProviderPriceId(sub.items[0].price.id)
  ├─ subscription.upsert(pricingOptionId ← gói mới, status, period, autoRenew)
  └─ nếu existing.pricingOptionId ≠ pricingOption.id
         && existing.status ∈ {ACTIVE, TRIALING, PAST_DUE}
       → isUpgrade = price_mới > price_cũ
       → subscriptionEvent UPGRADED | DOWNGRADED
         (oldPricingOptionId, newPricingOptionId)

invoice.paid (proration) → applyPaidInvoice()
  └─ credits ← plan_mới.renewalCredits
```

Xem [subscription-sync.service.ts:116-138](../src/stripe/sync/subscription-sync.service.ts#L116-L138).

> 🔴 **Điều kiện bắt buộc:** mọi `PricingOption` phải có `providerPriceId` trỏ đúng Price trên Stripe, và Price đó phải nằm trong danh sách cho phép của Portal Configuration. Nếu user đổi sang một Price mà DB không biết → `findByProviderPriceId` trả `null` → `syncFromStripe` log error và **`return null`** → hàng local giữ nguyên gói cũ trong khi **Stripe đã thu tiền gói mới**. Đây là lỗi âm thầm nguy hiểm nhất của flow này.

### 🟡 Edge case: `subscriptionCreditsRemaining` bị ghi đè, không cộng dồn

`applyPaidInvoice` dùng phép **gán** `subscriptionCreditsRemaining: plan.renewalCredits`, không phải `increment`. Đổi từ PRO (còn dư 800 credit) sang PRO-Yearly → credit thành `renewalCredits` của gói mới. Phần dư 800 biến mất, **không có `CreditTransaction` nào ghi lại việc mất đó**. Ledger và balance lệch nhau.

### 🟡 Edge case: portal cho hủy gói

Nếu bật, user hủy trong portal → `customer.subscription.updated` với `cancel_at_period_end = true` → `syncFromStripe` set `autoRenew = false`, `cancelledAt = cancel_at`. Kết quả giống hệt [Flow 9](#flow-9--hủy-gói-ở-cuối-kỳ), nhưng **không đi qua `POST /payments/cancel-subscription`**. Backend có hai đường vào cho cùng một hành động, và đường qua portal không có kiểm tra nào cả.

---

## Flow 9 — Hủy gói ở cuối kỳ

### `POST /payments/cancel-subscription`

Endpoint này **chỉ tồn tại ở `PaymentsController`**, không có bản `/stripe/*`.

```json
{ "reason": "Too expensive" }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `reason` | ❌ | **Không được dùng ở bất kỳ đâu** |

> 🟡 `reason` không log, không lưu vào `SubscriptionEvent.metadata`, không gửi sang Stripe — [payments.controller.ts:151-176](../src/payments/payments.controller.ts#L151-L176). Client gửi lên thì mất.

### 🔴 Cảnh báo về validation

Signature là `@Body() dto: CancelSubscriptionDto & { provider?: PaymentProvider }`. TypeScript emit metadata của **intersection type** thành `Object`, nên `ValidationPipe` bỏ qua hoàn toàn — dù [main.ts:17-26](../src/main.ts#L17-L26) bật `whitelist` và `forbidNonWhitelisted`.

Cùng vấn đề với `/payments/checkout`, `/payments/customers`, `/payments/payment-intent`. **Bốn endpoint này không có validation**, trong khi `/stripe/checkout/subscription` (dùng DTO thuần) thì có.

### Luồng

```
1. findById(userId)
2. !user.providerCustomerId → 400
3. subscription.findUnique({ userId })
     !sub || !sub.providerSubscriptionId → 400 "Active subscription not found."
4. stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true })
5. → 200 { data: null }
```

| Thiếu kiểm tra | Hậu quả |
|---|---|
| `status` | Có thể gọi trên sub đã `CANCELLED`/`EXPIRED`. Stripe ném lỗi thô → **500** |
| Gói free | User free bấm hủy → hủy sub free → cuối kỳ `deleted` → forfeit credit → `downgradeToFree` tạo lại sub free. Vòng lặp vô hại nhưng sinh event rác và reset credit |

### Sau response

Client **không gọi API nào tiếp**. Không có cách nào đọc `autoRenew` để hiển thị "sẽ hết hạn ngày X". **Không có API resume** — muốn hủy lệnh hủy phải vào [Billing Portal](#flow-8--đổi-gói-và-quản-lý-thẻ-qua-billing-portal).

### Chuỗi webhook — ngay lập tức

```
customer.subscription.updated (cancel_at_period_end = true)
  → không phải payment failure → syncFromStripe()
      → autoRenew   = (cancel_at_period_end === false) = false
      → cancelledAt = new Date(sub.cancel_at * 1000)
      → status vẫn ACTIVE   ✅ user vẫn dùng được tới cuối kỳ
```

### Chuỗi webhook — cuối kỳ

```
customer.subscription.deleted → CustomerSubscriptionDeletedStrategy
  ├─ findFirst({ providerSubscriptionId: sub.id }) → null → log error, RETURN
  ├─ nếu status ≠ CANCELLED → $transaction([
  │      subscription.update({ CANCELLED, cancelledAt, credits = 0 }),
  │      subscriptionEvent CANCELLED,
  │      creditTransaction EXPIRATION (-remaining)   ← chỉ khi remaining > 0
  │  ])
  ├─ nếu subscription.providerSubscriptionId ≠ sub.id → RETURN (upgrade detected)
  └─ freePlanDowngrade.downgradeToFree(sub, stripeSub, reason)
        ├─ getFreePriceId() → null → RETURN (im lặng)
        ├─ đã là free plan → RETURN
        ├─ re-read providerSubscriptionId, ≠ sub.id → RETURN   ← guard chống race
        ├─ ensureFreeSubscription(customerId)                  [Stripe]
        └─ $transaction:
             creditTransaction EXPIRATION (nếu còn dư)
             subscription.update({ pricingOption ← FREE, ACTIVE,
                                   providerSubscriptionId ← free_sub,
                                   credits = free.renewalCredits,
                                   cancelledAt: null })
             creditTransaction RENEWAL (free credits)
             subscriptionEvent DOWNGRADED
```

### 🔴 Edge case: trạng thái kẹt vĩnh viễn

`downgradeToFree` **gọi Stripe (`ensureFreeSubscription`) TRƯỚC khi mở transaction** — [free-plan-downgrade.service.ts:57](../src/stripe/webhook/free-plan-downgrade.service.ts#L57).

Nếu transaction fail sau đó:
1. Sub free đã tồn tại trên Stripe nhưng DB không biết.
2. Lần sau `ensureFreeSubscription` thấy `findActiveSubscription` có kết quả → trả `null` → `downgradeToFree` return sớm.
3. User kẹt ở `CANCELLED` trong DB nhưng có sub free trên Stripe.
4. `FreePlanReconciliationCron` **không cứu được**, vì `findIncompleteOnboardingUsers` lọc `subscription: null` — mà row subscription vẫn tồn tại, chỉ sai trạng thái.

**Guard đúng:** `subscriptionCreditsRemaining` bị set `0` trong transaction thứ nhất, rồi `downgradeToFree` đọc lại `remaining` (= 0) nên **không ghi `EXPIRATION` lần hai**.

---

## Flow 10 — Thanh toán gia hạn thất bại

Không có API nào khởi tạo flow này. Nó bắt đầu từ Stripe.

```
invoice.payment_failed → InvoicePaymentFailedStrategy
  └─ $transaction:
       subscription = findFirst({ providerSubscriptionId })
       ├─ tìm thấy → invoice.upsert({ retryCount: attempt_count,
       │                               nextRetryAt: next_payment_attempt })
       └─ không thấy → invoice.update({ where: providerInvoiceId })
             ⚠️ nếu invoice cũng không tồn tại → Prisma ném P2025
                → rollback → webhook markFailed → KHÔNG throw
                → Stripe không retry → event chết
             (dòng `if (!invoice)` bên dưới là dead code, update đã throw)
       subscription.update({ status: PAST_DUE })
       subscriptionEvent PAYMENT_FAILED

  → cancelIfRetriesExhausted():
       retriesUsed    = attempt_count - 1
       windowExceeded = now - invoice.createdAt > 3 ngày
       nếu retriesUsed < 3 && !windowExceeded → return (chờ Stripe retry)
       ngược lại:
         stripe.cancelSubscriptionNow()             [Stripe]
         invoice.update({ UNCOLLECTIBLE, nextRetryAt: null })
```

> 🟡 `windowExceeded` so với `invoice.createdAt` — thời điểm **hàng invoice được ghi vào DB local**, không phải ngày Stripe phát hành hóa đơn. Với invoice tạo lần đầu bởi chính event này, hai giá trị gần nhau. Với invoice đã tồn tại từ `invoice.paid` trước đó thì không.

### Hai đường dẫn tới hai trạng thái khác nhau

**Đường A — hệ thống chủ động hủy** (`cancelIfRetriesExhausted`):

```
cancelSubscriptionNow()
  → customer.subscription.deleted
  → CustomerSubscriptionDeletedStrategy → CANCELLED → downgradeToFree
```

`cancellation_details.reason` lúc này là `null` (do API chủ động hủy), nên nhánh `isPaymentFailure` trong `CustomerSubscriptionUpdatedStrategy` **không** khớp.

**Đường B — để Stripe tự xử lý** (dunning hết hạn, `status → unpaid`):

```
customer.subscription.updated (status = unpaid)
  → isPaymentFailure() = true
  → handlePaymentFailureExpiration()
       $transaction: status = EXPIRED, credits = 0,
                     subscriptionEvent EXPIRED,
                     creditTransaction EXPIRATION
  → downgradeToFree(reason: "payment_failed")
```

Đường A cho `CANCELLED`, đường B cho `EXPIRED`. Cả hai đều kết thúc ở free plan.

### Khôi phục

User vào [Billing Portal](#flow-8--đổi-gói-và-quản-lý-thẻ-qua-billing-portal) → cập nhật thẻ → Stripe thu lại:

```
invoice.paid → applyPaidInvoice → status = ACTIVE, credits = renewalCredits

customer.subscription.updated (past_due → active)
  → handlePaymentRecovery(): previousStatus === PAST_DUE && current === ACTIVE
  → subscriptionEvent PAYMENT_RECOVERED
```

> 🟡 `previousStatus` được đọc **trước** khi gọi `syncFromStripe` — [customer.subscription.updated.ts:63-69](../src/stripe/webhook/strategies/customer.subscription.updated.ts#L63-L69). Nếu `invoice.paid` đã kịp set `ACTIVE` trước đó, `previousStatus` sẽ là `ACTIVE` → **không có event `PAYMENT_RECOVERED`**. Event này phụ thuộc thứ tự webhook, nên không đáng tin để làm audit trail.

---

## Flow 11 — `POST /stripe/payment-intent` (không nên dùng)

```json
{ "amount": 1000, "currency": "usd", "description": "..." }
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `amount` | ✅ | `@Min(50)`. Đơn vị **cents**, truyền thẳng cho Stripe |
| `currency` | ❌ | Mặc định `"usd"` |
| `description` | ❌ | — |

**Luồng:** `stripe.paymentIntents.create({ metadata: { userId } })` → `prisma.payment.create({ status: PENDING, amount })`.

### 🔴 Hai lỗi khiến endpoint này không hoàn chỉnh

1. **`metadata` chỉ có `userId`, không có `addonPackageId`.** Khi `payment_intent.succeeded` tới, `PaymentIntentSucceededStrategy` kiểm tra `if (!addonPackageId || !userIdStr) return` — [payment-intent-succeeded.strategy.ts:31](../src/stripe/webhook/strategies/payment-intent-succeeded.strategy.ts#L31) → skip. Hàng `Payment` **mắc kẹt ở `PENDING` vĩnh viễn** dù tiền đã vào tài khoản Stripe.

2. **`amount` ghi vào DB dạng cents thô** — [stripe.adapter.ts:230](../src/stripe/adapter/stripe.adapter.ts#L230) — trong khi mọi nơi khác dùng `formatStripeAmountToDatabase()`. `GET /stripe/payments` trộn lẫn hai đơn vị: `1000` (cents, từ endpoint này) và `10` (dollars, từ webhook).

**Không dùng endpoint này cho addon.** Dùng [`POST /stripe/checkout/addon`](#flow-6--mua-addon-credits).

---

## Flow 12 — Admin

### `POST /stripe/customers` — gần như vô dụng

Có `@Roles(Role.ADMIN)` nhưng lại dùng `@GetUser("id") userId` — [stripe.controller.ts:42-45](../src/stripe/stripe.controller.ts#L42-L45) — tức tạo Stripe customer cho **chính admin đang gọi**, không phải cho user nào khác. Không có param nhận `userId` mục tiêu.

> 🔴 Trong khi đó `POST /payments/customers` làm đúng việc đó và **không có `@Roles`** → user thường tự gọi được. Hai endpoint cùng chức năng, hai mức quyền ngược nhau.

### `GET /users/:id` — IDOR

`@Roles(Role.ADMIN, Role.USER)`. `RolesGuard` chỉ kiểm tra user **có role nào đó trong danh sách**, không kiểm tra `params.id === user.id` — [roles.guard.ts:35](../src/common/guards/roles.guard.ts#L35).

> 🔴 Mọi user đọc được profile của mọi user khác bằng cách đổi id.

### `DELETE /users/:id` — vỡ FK và bỏ rơi Stripe customer

`prisma.user.delete({ where: { id } })` trần — [users.service.ts:268](../src/users/users.service.ts#L268).

- User có `Subscription`, `Payment`, `CreditTransaction` → FK constraint → P2003 → **500**.
- Nếu user chưa có gì (vừa register xong nhưng webhook chưa tới) thì xóa được, nhưng **Stripe customer không bị xóa và không có `CleanupTask` nào được tạo** → mồ côi.

Cơ chế `CleanupTask` + `CleanupTaskCron` chỉ được kích hoạt từ `createAndPersistStripeCustomer` và `rollbackProvisionedUser`, **không** từ `deleteUser`.

---

## Cron — không có API, nhưng ảnh hưởng mọi flow

| Cron | Lịch | Tác động |
|---|---|---|
| [`CreditResetCronService`](../src/cron/credit-reset.cron.ts) | mỗi ngày 00:00 | Reset `subscriptionCreditsRemaining` cho sub `ACTIVE` có `nextCreditResetAt <= now` và `currentPeriodEnd > now`. Dùng conditional `updateMany` + kiểm tra `count === 0` để tránh double-reset với `invoice.paid` |
| [`FreePlanReconciliationCron`](../src/cron/free-plan-reconciliation.cron.ts) | mỗi giờ | Tìm user `createdAt < now - 15min` có `providerCustomerId = null` **hoặc** `subscription = null` → tạo customer/free sub, hoặc heal từ Stripe qua `syncFromStripe` + `applyPaidInvoice`. Lưới an toàn cho [Flow 2](#flow-2--đăng-ký-user-onboarding--auto-free-plan) |
| [`CleanupTaskCron`](../src/cron/cleanup-task.cron.ts) | mỗi giờ | Xóa Stripe customer mồ côi, tối đa 5 lần rồi `FAILED` vĩnh viễn |

> 🔴 `FreePlanReconciliationCron` **không cứu được** trạng thái kẹt ở cuối [Flow 9](#flow-9--hủy-gói-ở-cuối-kỳ), vì điều kiện lọc là `subscription: null` mà hàng subscription vẫn tồn tại (chỉ sai trạng thái).

---

## Điều thực sự không làm được bằng API hiện tại

Hai thứ, và chỉ hai:

### 1. Tiêu credit

Không có endpoint nào trừ `subscriptionCreditsRemaining` hoặc `creditWallet.addonCredits`. `CreditTransactionType.USAGE` không bao giờ được ghi. **Không có cách nào lách bằng API hiện có** — hệ thống cấp credit nhưng không tiêu được.

### 2. Đọc trạng thái subscription và số dư credit

`GET /stripe/payments` là API đọc duy nhất, và nó chỉ trả `Payment`. Frontend không biết:

- user đang ở gói nào
- còn bao nhiêu credit
- kỳ hạn tới khi nào
- `autoRenew` là `true` hay `false`

Không thể suy ra từ `GET /pricing/plans` (public catalog) hay `GET /users/:id` (chỉ trả `User`, không include `subscription`).

---

Mọi chức năng còn lại — kể cả **đổi gói, hủy gói, resume, đổi thẻ, xem hóa đơn** — đều làm được bằng `POST /stripe/billing-portal`, vì `SubscriptionSyncService` đã xử lý sẵn mọi webhook mà portal sinh ra.

---

## Ba vấn đề chặn đường, xếp theo mức độ

1. **`POST /auth/login` không có password.** Biết email admin là chiếm được quyền admin.
2. **Bốn endpoint `/payments/*` không có validation** do dùng intersection type ở `@Body()`, và `POST /payments/checkout` bỏ qua rule "không được checkout khi đang có gói trả phí" mà `/stripe/checkout/subscription` áp dụng. Có thể bypass rule business bằng cách gọi endpoint kia.
3. **`POST /stripe/payment-intent` tạo `Payment` mắc kẹt `PENDING` với sai đơn vị tiền tệ.**

---

## Chú thích ký hiệu

| Ký hiệu | Nghĩa |
|---|---|
| 🔴 | Rủi ro cao — mất tiền, sai dữ liệu, hoặc lỗ hổng bảo mật |
| 🟡 | Cần biết — hành vi bất ngờ hoặc nợ kỹ thuật |
| ✅ | Hành vi đúng, đã có guard bảo vệ |
