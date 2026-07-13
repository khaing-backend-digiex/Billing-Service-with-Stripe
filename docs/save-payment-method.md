# Feature: Save Payment Method — Phân tích kiến trúc & workflow

Tài liệu **chỉ phân tích workflow và kiến trúc**. Không thiết kế API, không code.

Ngày: 2026-07-13 · Nhánh: `fix/user-credit` · Liên quan: [billing-flows.md](./billing-flows.md)

---

## Mục lục

- [Tóm tắt](#tóm-tắt)
- [Hiện trạng — ba phát hiện định hình toàn bộ thiết kế](#hiện-trạng--ba-phát-hiện-định-hình-toàn-bộ-thiết-kế)
- [Nguyên tắc kiến trúc](#nguyên-tắc-kiến-trúc)
- [Mô hình đối tượng Stripe](#mô-hình-đối-tượng-stripe)
- [User flow](#user-flow)
- [Stripe flow & bộ webhook cần có](#stripe-flow--bộ-webhook-cần-có)
- [Luồng mua Subscription thay đổi thế nào](#luồng-mua-subscription-thay-đổi-thế-nào)
- [Luồng mua Addon thay đổi thế nào](#luồng-mua-addon-thay-đổi-thế-nào)
- [Trạng thái & edge cases](#trạng-thái--edge-cases)
- [Phân định trách nhiệm](#phân-định-trách-nhiệm--cái-gì-thuộc-billing-service)
- [Quyết định cần chốt trước khi thiết kế API](#quyết-định-cần-chốt-trước-khi-thiết-kế-api)

---

## Tóm tắt

Feature này **không phải là "bắt đầu lưu thẻ"** — Stripe đã và đang lưu thẻ rồi. Nó là việc **giành lại quyền kiểm soát một hành vi mà Stripe đang làm ngầm**, và biến thẻ đã lưu thành thứ có thể tái sử dụng.

Ba thay đổi cốt lõi:

1. **Thêm một đường vào mới để lưu thẻ mà không cần mua gì** — SetupIntent. Đây là phần "mới" duy nhất về mặt Stripe.
2. **Chuẩn hóa nơi lưu "thẻ mặc định"** về `Customer.invoice_settings.default_payment_method`. Hiện tại nơi này **đang rỗng** với mọi user, kể cả user đã trả tiền (xem phát hiện #2 bên dưới).
3. **Chuyển luồng mua từ redirect-Checkout sang charge off-session** khi đã có thẻ mặc định. Đây là phần khó nhất, vì nó sinh ra một trạng thái mà hệ thống hiện chưa từng có: **`requires_action` (3DS)**.

Rủi ro lớn nhất **không** nằm ở việc lưu thẻ. Nó nằm ở chỗ: hôm nay mọi khoản thu đều diễn ra **on-session** (user đang ngồi trước màn hình Checkout, Stripe lo 3DS). Sau feature này, phần lớn khoản thu diễn ra **off-session**, và off-session **có thể thất bại theo những cách mà on-session không có** — đặc biệt là `authentication_required`.

---

## Hiện trạng — ba phát hiện định hình toàn bộ thiết kế

### 1. Bảng `PaymentMethod` đã tồn tại nhưng là schema chết

[`prisma/schema.prisma`](../prisma/schema.prisma) — model `PaymentMethod` có đủ `providerPaymentMethodId`, `isDefault`, `metadata`. **Không có một dòng code nào ghi vào nó.** Quan hệ `User.paymentMethods` cũng chưa từng được đọc.

Nghĩa là: không cần migration phá vỡ gì cả, nhưng cũng **không được tin** rằng bảng này đang phản ánh thực tế. Nó rỗng.

### 2. 🔴 Thẻ đã được lưu sẵn trên Stripe — nhưng "default" thì không

Đây là phát hiện quan trọng nhất.

`createCheckoutSession` với `mode: "subscription"` — [stripe.adapter.ts:130](../src/stripe/adapter/stripe.adapter.ts#L130) — khiến Stripe **tự động attach thẻ vào Customer và set nó làm `Subscription.default_payment_method`**. Đây là hành vi mặc định của Checkout, không phải thứ code này chủ động làm.

Hệ quả, với một user đã mua gói PRO hôm nay:

| Vị trí | Giá trị thực tế |
|---|---|
| `PaymentMethod` attached vào Customer | ✅ Có |
| `Subscription.default_payment_method` | ✅ Có |
| `Customer.invoice_settings.default_payment_method` | ❌ **RỖNG** |
| Bảng `PaymentMethod` local | ❌ **RỖNG** |

Và `hasDefaultPaymentMethod()` — [stripe.adapter.ts:201](../src/stripe/adapter/stripe.adapter.ts#L201) — đọc `invoice_settings` trước, **thấy rỗng**, rồi mới fallback sang `paymentMethods.list()`. Cái fallback đó là thứ duy nhất cứu nó khỏi trả về `false` sai. (Hàm này hiện cũng **không có caller nào** — nó là dead code.)

**Hệ quả cho thiết kế:**

- Thẻ nằm ở **subscription level**, không phải customer level. Nếu mua addon off-session, `Customer.invoice_settings.default_payment_method` rỗng → **không biết charge bằng thẻ nào**, dù thẻ đang nằm sẵn đó.
- Cần một bước **backfill**: với user đã có thẻ, đọc từ Stripe → set `invoice_settings.default_payment_method` → mirror xuống DB. Không mất dữ liệu, không bắt user nhập lại thẻ.
- Chuẩn hóa: **customer-level default là source of truth**, một thẻ phục vụ cả subscription lẫn addon. Không dùng subscription-level override (trừ khi sau này có nhu cầu "thẻ công ty cho gói, thẻ cá nhân cho addon" — hiện chưa có).

### 3. Billing Portal đã cho user đổi thẻ rồi

[Flow 8](./billing-flows.md#flow-8--đổi-gói-và-quản-lý-thẻ-qua-billing-portal) — `POST /stripe/billing-portal` mở portal của Stripe, trong đó user **đã có thể thêm/xóa/đổi thẻ**.

Feature này vì thế là một **cánh cửa thứ hai vào cùng một hành động** — đúng cái pattern đã gây rắc rối ở Flow 8 với việc hủy gói ("Backend có hai đường vào cho cùng một hành động, và đường qua portal không có kiểm tra nào cả").

Không được lặp lại sai lầm đó. Xem [Quyết định #1](#1-billing-portal--giữ-hay-tắt-phần-payment-method).

---

## Nguyên tắc kiến trúc

Bám theo nguyên tắc đã có của hệ thống: **Stripe là source of truth, webhook là đường ghi duy nhất.**

```
                    ┌──────────────────────────────┐
                    │   STRIPE  (source of truth)  │
                    │  Customer · PaymentMethod    │
                    │  invoice_settings.default_pm │
                    └──────────────────────────────┘
                       ▲                      │
              lệnh ghi │                      │ webhook
       (attach/detach/ │                      │ (sự kiện đã xảy ra)
        set default)   │                      ▼
                    ┌──────────────────────────────┐
                    │      BILLING SERVICE         │
                    │  ┌────────────────────────┐  │
                    │  │  Command side          │  │  → gọi Stripe, KHÔNG ghi DB
                    │  │  (SetupIntent, detach) │  │
                    │  └────────────────────────┘  │
                    │  ┌────────────────────────┐  │
                    │  │  Webhook side          │  │  → nguồn ghi DB DUY NHẤT
                    │  │  (strategies)          │  │
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  DB.PaymentMethod            │
                    │  = READ MODEL / CACHE        │
                    │  không authoritative         │
                    └──────────────────────────────┘
```

**Ba quy tắc rút ra:**

1. **Command không ghi DB.** API "xóa thẻ" gọi `stripe.paymentMethods.detach()` rồi trả về. Hàng local biến mất khi `payment_method.detached` webhook tới — không phải trong request. Điều này tránh đúng cái bug ở [Flow 9](./billing-flows.md#-edge-case-trạng-thái-kẹt-vĩnh-viễn), nơi Stripe được gọi trước transaction rồi transaction fail → kẹt vĩnh viễn.

2. **`DB.PaymentMethod` là cache, không phải sự thật.** Nó tồn tại để `GET /payment-methods` không phải gọi Stripe mỗi lần. Mọi *quyết định* (charge bằng thẻ nào, có được xóa không) phải chịu được việc cache sai. Khi nghi ngờ → đọc lại từ Stripe.

3. **Không bao giờ lưu số thẻ.** Local chỉ giữ `pm_xxx` + metadata hiển thị (brand, last4, exp_month, exp_year, fingerprint). PAN/CVV **không đi qua server** — Stripe.js/Elements gửi thẳng lên Stripe. Đây là ranh giới PCI, không phải lựa chọn kỹ thuật.

---

## Mô hình đối tượng Stripe

| Đối tượng Stripe | Vai trò | Map sang local |
|---|---|---|
| `Customer` | Đã có sẵn | `User.providerCustomerId` |
| `SetupIntent` | Thu thập + xác thực thẻ **mà không charge**. Chạy 3DS ngay lúc này để lần sau charge off-session không bị chặn. | Không cần lưu (ephemeral) |
| `PaymentMethod` (`pm_xxx`) | Thẻ đã attach vào Customer | `PaymentMethod.providerPaymentMethodId` |
| `Customer.invoice_settings.default_payment_method` | **Thẻ mặc định — source of truth** | `PaymentMethod.isDefault` (dẫn xuất) |
| `Subscription.default_payment_method` | Override per-sub | **Không dùng.** Để `null` → Stripe tự fallback về customer default |
| `PaymentMethod.card.fingerprint` | Định danh thẻ vật lý (khác `pm_id`) | Dùng để **chống trùng thẻ** |

**Điểm mấu chốt về `usage: off_session`:** SetupIntent phải được tạo với `usage: "off_session"`. Nó báo cho ngân hàng biết "thẻ này sẽ bị charge sau, khi user không có mặt" → ngân hàng chạy 3DS **ngay bây giờ** và cấp một "mandate". Nếu bỏ qua, mọi lần charge off-session về sau sẽ có nguy cơ bị trả về `authentication_required` — biến một khoản thu tự động thành một khoản thu cần user quay lại bấm nút.

---

## User flow

### A. Thêm thẻ đầu tiên (chủ động, không mua gì)

```
User: "Thêm thẻ"  (Settings → Payment methods)
  │
  ├─ FE gọi BE: xin client_secret
  │     BE: ensureStripeCustomerId(user)         [Stripe, nếu chưa có]
  │         stripe.setupIntents.create({
  │           customer, usage: 'off_session'
  │         })                                    [Stripe]
  │     BE → FE: client_secret
  │     ⚠️ BE KHÔNG ghi DB ở bước này
  │
  ├─ FE: Stripe Elements render form thẻ
  │     User nhập số thẻ  → gửi THẲNG lên Stripe (không qua BE)
  │     stripe.confirmSetup(client_secret)
  │       ├─ Cần 3DS → hiện modal ngân hàng → user xác thực
  │       └─ Xong → SetupIntent.status = succeeded
  │
  ├─ FE: hiện "Đang xử lý..." (KHÔNG hiện "Đã thêm thẻ" ngay)
  │
  └─ Stripe → BE webhook:
        payment_method.attached      → tạo hàng PaymentMethod local
        setup_intent.succeeded       → nếu là thẻ đầu tiên:
                                         set invoice_settings.default_pm   [Stripe]
        customer.updated             → set isDefault = true trên hàng local
  │
  └─ FE poll (hoặc nhận realtime) → hiện thẻ trong danh sách
```

> 🔴 **Khoảng trễ giữa `confirmSetup` thành công và webhook tới là có thật** — đây chính xác là vấn đề đã có ở [Flow 2](./billing-flows.md#flow-2--đăng-ký-user-onboarding--auto-free-plan) ("Giữa lúc register trả 201 và lúc webhook tới, user tồn tại nhưng chưa có gói"). FE **không được** giả định thẻ đã sẵn sàng ngay khi `confirmSetup` resolve. Xem [Quyết định #2](#2-xử-lý-độ-trễ-webhook-ở-fe).

### B. Thêm thẻ thứ hai

Giống flow A, **trừ** bước set default: thẻ mới **không** tự động thành default. User phải chủ động chọn. (Nếu tự động set default, user thêm thẻ để "dự phòng" lại vô tình đổi thẻ thanh toán chính → bất ngờ.)

### C. Đổi thẻ mặc định

```
User chọn thẻ B → "Đặt làm mặc định"
  → BE: kiểm tra pm thuộc về customer của user  ← chống IDOR
        kiểm tra thẻ chưa hết hạn
        stripe.customers.update(invoice_settings.default_payment_method = pm_B)
  → webhook customer.updated
        → transaction: isDefault=false cho mọi thẻ, isDefault=true cho pm_B
```

> Việc set `isDefault` phải là **một transaction đặt lại toàn bộ**, không phải hai lệnh update rời. Nếu không, hai request đồng thời → **hai thẻ cùng `isDefault = true`** → charge bằng thẻ nào là không xác định.

### D. Xóa thẻ

```
User chọn thẻ → "Xóa"
  → BE kiểm tra (xem bảng edge cases):
        ├─ pm có thuộc user không?             → không → 403
        ├─ có phải thẻ mặc định không?
        │     └─ VÀ đang có subscription trả phí active?
        │           → 🔴 CHẶN hoặc BẮT chọn thẻ thay thế
        └─ ok → stripe.paymentMethods.detach()   [Stripe]
  → webhook payment_method.detached → xóa hàng local
```

### E. Xem danh sách thẻ

Đọc từ `DB.PaymentMethod` (cache). Không gọi Stripe — trừ khi cần độ chính xác tuyệt đối (ví dụ: ngay trước khi charge).

---

## Stripe flow & bộ webhook cần có

Hiện hệ thống đăng ký **5 strategy** — [stripe.module.ts](../src/stripe/stripe.module.ts). Feature này cần thêm:

| Webhook event | Vì sao cần | Ghi gì |
|---|---|---|
| `payment_method.attached` | **Nguồn tạo hàng `PaymentMethod` duy nhất** | Tạo row: pm_id, brand, last4, exp, fingerprint |
| `payment_method.detached` | Xóa thẻ (từ app **hoặc** từ Billing Portal) | Xóa row |
| `payment_method.updated` / `.automatically_updated` | Stripe Card Updater tự cập nhật thẻ hết hạn qua mạng lưới Visa/MC | Cập nhật exp/last4 |
| `customer.updated` | **Nguồn duy nhất đổi `isDefault`** — đọc `invoice_settings.default_payment_method` | Reset toàn bộ `isDefault` trong 1 transaction |
| `setup_intent.succeeded` | Xác nhận thẻ đã verified. Trigger auto-set-default nếu là thẻ đầu | Có thể set default |
| `setup_intent.setup_failed` | Thẻ bị từ chối lúc thêm | Log / báo FE. **Không có gì để rollback** — pm chưa từng được attach |
| `invoice.payment_action_required` | 🔴 **MỚI VÀ QUAN TRỌNG** — renewal off-session cần 3DS | Đánh dấu sub cần user hành động |
| `payment_intent.payment_failed` | 🔴 Addon off-session bị từ chối. **Hiện KHÔNG có strategy nào** → `Payment` kẹt `PENDING` mãi | Set `Payment.FAILED` |

> 🟡 `customer.updated` bắn cho **mọi** thay đổi trên Customer (email, name, address...), không chỉ default payment method. Strategy phải so sánh với giá trị local và **no-op nếu `invoice_settings.default_payment_method` không đổi** — nếu không sẽ chạy transaction reset `isDefault` mỗi lần user đổi tên.

---

## Luồng mua Subscription thay đổi thế nào

### Hôm nay

```
POST /stripe/checkout/subscription → Checkout URL → REDIRECT ra khỏi app
  → user nhập thẻ trên trang Stripe (on-session, Stripe lo 3DS)
  → invoice.paid → InvoicePaidStrategy → cấp credit
```

### Sau feature

```
POST /stripe/checkout/subscription (tên endpoint có thể giữ)
  │
  ├─ có thẻ mặc định? ──── KHÔNG ──→ hai lựa chọn (xem Quyết định #3):
  │                                    (a) buộc thêm thẻ trước (SetupIntent)
  │                                    (b) fallback về Checkout như cũ
  │
  └─ CÓ ──→ stripe.subscriptions.create({
              customer,
              items: [price],
              default_payment_method: null   ← để trống, dùng customer default
            })                                                    [Stripe]
            KHÔNG redirect. KHÔNG rời app.
              │
              ├─ Thu tiền OK ngay
              │    → invoice.paid  →  InvoicePaidStrategy   ✅ ĐÃ CÓ, không đổi
              │
              ├─ 🔴 Cần 3DS (off-session)
              │    → sub.status = incomplete
              │    → invoice.payment_action_required
              │    → PHẢI đưa user quay lại xác thực (on-session)
              │    → nếu user bỏ đi: 23h sau Stripe → incomplete_expired
              │
              └─ Thẻ bị từ chối
                   → sub.status = incomplete, invoice.payment_failed
                   → KHÔNG cấp credit, KHÔNG có gói
```

**Điểm quan trọng: phần webhook gần như không phải sửa.** `InvoicePaidStrategy` không quan tâm invoice sinh ra từ Checkout hay từ `subscriptions.create` — nó chỉ đọc invoice. Đây là lợi thế lớn của kiến trúc webhook-driven hiện tại.

**Nhưng có hai chỗ vỡ:**

1. 🔴 **Trạng thái `incomplete` chưa từng tồn tại trong hệ thống này.** `STRIPE_STATUS_MAP` — [stripe.adapter.ts:30](../src/stripe/adapter/stripe.adapter.ts#L30) — map `incomplete → PAST_DUE`. Với Checkout, `incomplete` gần như không bao giờ xảy ra (user đang ngồi đó, thanh toán xong mới có sub). Với off-session, **`incomplete` là chuyện thường ngày**. Map nó thành `PAST_DUE` sẽ khiến một subscription *chưa từng được thanh toán lần nào* trông giống một subscription *đang trễ hạn*. Hai thứ này cần xử lý khác nhau.

2. 🔴 **Rule "chỉ user gói free mới được checkout"** — [stripe.controller.ts:87](../src/stripe/stripe.controller.ts#L87) — vẫn còn đó. Nếu user tạo sub off-session mà rơi vào `incomplete`, hàng local (nếu có) có thể chặn họ thử lại. Cần định nghĩa rõ: sub `incomplete` **không** tính là "đang có gói trả phí".

---

## Luồng mua Addon thay đổi thế nào

### Hôm nay

```
POST /stripe/checkout/addon → Checkout URL → redirect
  → mode: "payment"  ⚠️ KHÔNG có setup_future_usage → thẻ KHÔNG được lưu
  → payment_intent.succeeded (metadata.addonPackageId) → cộng credit
```

### Sau feature — đây là nơi feature "tỏa sáng" nhất

Mua addon là hành vi **lặp lại, giá trị nhỏ, cần nhanh**. Bắt redirect ra Stripe mỗi lần mua 1000 credit là trải nghiệm tệ nhất trong hệ thống hiện tại.

```
POST /stripe/checkout/addon
  │
  └─ CÓ thẻ mặc định ──→ stripe.paymentIntents.create({
                            customer,
                            payment_method: <default pm>,
                            off_session: true,
                            confirm: true,              ← charge NGAY
                            metadata: { userId, addonPackageId }   ← GIỮ NGUYÊN
                          })
                          │
                          ├─ succeeded
                          │    → payment_intent.succeeded
                          │    → PaymentIntentSucceededStrategy  ✅ ĐÃ CÓ, không đổi
                          │       (nó chỉ đọc metadata — không quan tâm nguồn gốc PI)
                          │    → cộng credit
                          │    → 🎉 User bấm 1 nút, không rời trang
                          │
                          ├─ 🔴 lỗi authentication_required
                          │    → Stripe THROW error ngay tại lời gọi create()
                          │      (không phải webhook!)
                          │    → error.payment_intent.client_secret có sẵn
                          │    → FE dùng nó để chạy 3DS on-session → confirm lại
                          │
                          └─ card_declined
                               → payment_intent.payment_failed
                               → 🔴 CHƯA CÓ STRATEGY → Payment kẹt PENDING
```

> ✅ **`metadata` là thứ cứu chúng ta.** [Flow 6](./billing-flows.md#flow-6--mua-addon-credits) ghi: metadata `{ userId, addonPackageId }` "là toàn bộ cơ sở để webhook biết đây là giao dịch addon". Vì `PaymentIntentSucceededStrategy` chỉ đọc metadata chứ không quan tâm PI được tạo bằng Checkout hay bằng API trực tiếp, **luồng cấp credit không cần sửa một dòng nào.**

> 🔴 **Nhưng `POST /stripe/payment-intent` hiện tại (Flow 11) là một cái bẫy.** Nó tạo PI với metadata **chỉ có `userId`, thiếu `addonPackageId`** → webhook skip → `Payment` kẹt `PENDING` với sai đơn vị tiền tệ (cents thay vì dollars). Endpoint đó **không được** tái sử dụng cho luồng này. Nó cần bị xóa hoặc sửa, chứ không phải bị mở rộng.

---

## Trạng thái & edge cases

### Vòng đời một PaymentMethod

```
                  (chưa có thẻ)
                       │
                       │ SetupIntent + confirm
                       ▼
               ┌──────────────┐   setup_failed   ┌──────────┐
               │  PROCESSING  │─────────────────→│ REJECTED │ (không attach, không có gì dọn)
               └──────┬───────┘                  └──────────┘
                      │ payment_method.attached
                      ▼
               ┌──────────────┐  customers.update  ┌──────────────┐
               │    ACTIVE    │←──────────────────→│   DEFAULT    │
               │ (không mặc   │  customer.updated  │ (invoice_    │
               │  định)       │                    │  settings)   │
               └──────┬───────┘                    └──────┬───────┘
                      │            detach                 │
                      └──────────────┬────────────────────┘
                                     ▼
                              ┌──────────────┐
                              │   DETACHED   │ (xóa row local)
                              └──────────────┘

        Trạng thái ngang: EXPIRED (exp_month/year < hiện tại)
                          → vẫn ACTIVE trên Stripe, vẫn có thể là DEFAULT
                          → nhưng charge sẽ FAIL
                          → Stripe KHÔNG bắn webhook nào khi thẻ hết hạn!
```

### Bảng edge cases

| # | Tình huống | Hành vi cần có | Mức |
|---|---|---|---|
| 1 | **Chưa có thẻ nào**, mua subscription | Buộc thêm thẻ trước, hoặc fallback Checkout. Không được để "im lặng không làm gì" như `getFreePriceId()` | 🔴 |
| 2 | **Chưa có thẻ**, mua addon | Chặn với lỗi rõ ràng + gợi ý thêm thẻ. Không fallback âm thầm | 🟡 |
| 3 | **Xóa thẻ mặc định** khi đang có sub trả phí active | 🔴 **Chặn**, hoặc bắt chọn thẻ thay thế trong cùng thao tác. Nếu cho xóa: renewal kỳ sau fail → user mất gói vì một cú click ở màn hình Settings | 🔴 |
| 4 | **Xóa thẻ cuối cùng** khi có sub trả phí | Như #3. Không có thẻ thay thế → phải chặn thẳng | 🔴 |
| 5 | **Xóa thẻ không phải mặc định** | Cho phép tự do | ✅ |
| 6 | **Thẻ hết hạn** | Stripe **không bắn webhook nào**. Phải: (a) cron quét `exp` sắp tới → cảnh báo, VÀ/HOẶC (b) bật **Stripe Card Updater** để mạng lưới tự cập nhật → `payment_method.automatically_updated` | 🔴 |
| 7 | **Thẻ bị từ chối lúc thêm** (SetupIntent) | `setup_intent.setup_failed`. PM chưa từng attach → **không có gì để dọn**. Chỉ cần báo FE | ✅ |
| 8 | **Thẻ bị từ chối lúc charge off-session** (renewal) | Rơi vào [Flow 10](./billing-flows.md#flow-10--thanh-toán-gia-hạn-thất-bại) đã có sẵn: `PAST_DUE` → dunning → 3 lần retry → hủy | ✅ |
| 9 | 🔴 **`authentication_required` off-session** | **Trạng thái hoàn toàn mới.** Thẻ hợp lệ, tiền có, nhưng ngân hàng đòi 3DS mà user thì không có mặt. Charge fail. Phải kéo user quay lại app để xác thực on-session. Cần: webhook `invoice.payment_action_required` + một trạng thái "cần hành động" + kênh thông báo (email) | 🔴 |
| 10 | **Nhiều thẻ** | Đúng một thẻ có `isDefault = true`. Enforce bằng transaction reset-all, không phải bằng hai update rời | 🔴 |
| 11 | **Thêm trùng thẻ** (cùng thẻ vật lý, 2 lần) | Stripe **cho phép** — tạo 2 `pm_id` khác nhau, cùng `card.fingerprint`. Cần dedupe theo fingerprint, nếu không user thấy 2 thẻ "•••• 4242" giống hệt nhau | 🟡 |
| 12 | **Race: set default 2 thẻ đồng thời** | Transaction reset-all + đọc lại từ `customer.updated` (Stripe là trọng tài) | 🟡 |
| 13 | **Drift: DB có thẻ mà Stripe không có** | Do webhook miss/fail. Cần cron reconcile — cùng tinh thần với `FreePlanReconciliationCron` đã có | 🟡 |
| 14 | **User đổi thẻ qua Billing Portal** | Portal bắn `payment_method.attached`/`.detached`/`customer.updated` → **cùng bộ webhook** → tự sync. ✅ **Miễn là** ta xử lý đủ 3 event trên. Đây là lý do phải làm webhook đầy đủ ngay từ đầu, kể cả khi tự build UI | 🔴 |
| 15 | **Xóa user** (`DELETE /users/:id`) | Hiện đã bỏ rơi Stripe customer ([Flow 12](./billing-flows.md#flow-12--admin)). Thêm PM không làm tệ hơn (detach theo customer), nhưng đừng quên | 🟡 |
| 16 | **User đã có thẻ từ Checkout cũ** (trước feature) | 🔴 **Backfill bắt buộc.** `invoice_settings.default_payment_method` đang rỗng (phát hiện #2). Không backfill → user đã trả tiền vẫn bị hỏi thẻ khi mua addon → **user sẽ nghĩ hệ thống hỏng** | 🔴 |
| 17 | **SetupIntent tạo xong, user bỏ ngang** | SetupIntent hết hạn, không attach gì. Không rác. BE không ghi DB ở bước tạo → không có row mồ côi | ✅ |
| 18 | **PM của user A, user B gọi API xóa** | 🔴 IDOR — hệ thống này **đã có tiền lệ** (`GET /users/:id`, [Flow 12](./billing-flows.md#flow-12--admin)). Mọi thao tác trên `pm_xxx` **phải** verify pm thuộc `user.providerCustomerId` | 🔴 |

---

## Phân định trách nhiệm — cái gì thuộc Billing Service

### ✅ Thuộc Billing Service

| Trách nhiệm | Ghi chú |
|---|---|
| Tạo SetupIntent (server-side, gắn `customer` + `usage: off_session`) | Không bao giờ để FE tự chọn customer |
| Đảm bảo `providerCustomerId` tồn tại trước khi thêm thẻ | Tái dùng `ensureStripeCustomerId` đã có |
| **Authorization**: pm này có thuộc user này không | Chống IDOR — xem edge case #18 |
| **Business rules**: được xóa thẻ mặc định không? | Đây là *policy*, Stripe không biết và không quan tâm |
| Ra lệnh set default / detach sang Stripe | Command — không ghi DB |
| Webhook strategies → đồng bộ read model | Nguồn ghi DB **duy nhất** |
| Điều phối luồng mua: có thẻ → off-session, chưa có → SetupIntent | Orchestration |
| Backfill + reconcile cron | Chống drift |

### ❌ KHÔNG thuộc Billing Service

| Không làm | Lý do |
|---|---|
| **Nhận / lưu / log số thẻ, CVV** | Ranh giới PCI-DSS. Thẻ đi thẳng FE → Stripe qua Elements. Server **không bao giờ** thấy PAN. Vi phạm điều này là vấn đề pháp lý, không phải kỹ thuật |
| **Validate số thẻ (Luhn), BIN lookup** | Stripe làm. Tự làm = vừa thừa vừa sai |
| **UI 3DS / redirect ngân hàng** | Stripe.js lo. BE chỉ cung cấp `client_secret` |
| **Quyết định thẻ nào "hợp lệ" để charge** | Stripe + ngân hàng phát hành quyết định. BE chỉ đọc kết quả |
| **Coi `DB.PaymentMethod` là sự thật** | Nó là cache. Nghi ngờ → đọc Stripe |
| **Retry/dunning khi charge fail** | Stripe Smart Retries đã làm. [Flow 10](./billing-flows.md#flow-10--thanh-toán-gia-hạn-thất-bại) đã bám vào đó |
| **Gửi email "thẻ sắp hết hạn"** | Là việc của Notification Service. Billing Service chỉ **phát ra sự kiện**, không tự gửi mail |
| **Lưu lịch sử "ai đổi thẻ lúc nào"** như một audit trail tài chính | Nếu cần → là `SubscriptionEvent`-style event riêng, không nhét vào `PaymentMethod.metadata` |

---

## Quyết định cần chốt trước khi thiết kế API

Bốn quyết định này thay đổi hình dạng của API. Cần chốt trước.

### 1. Billing Portal — giữ hay tắt phần payment method?

- **Tắt** (khuyến nghị): một cửa duy nhất, business rules được áp dụng nhất quán. Portal chỉ còn để xem hóa đơn.
- **Giữ cả hai**: user có 2 đường đổi thẻ. **Vẫn phải làm đủ webhook** (edge case #14), nhưng rule "không được xóa thẻ mặc định khi có sub active" sẽ **không được áp dụng ở đường portal** → đúng cái bug hai-cửa của [Flow 8](./billing-flows.md#-edge-case-portal-cho-hủy-gói).

### 2. Xử lý độ trễ webhook ở FE

Sau `confirmSetup()` thành công, thẻ **chưa** có trong DB local. FE poll? Optimistic UI? Hay BE đọc thẳng Stripe cho endpoint `GET /payment-methods` (bỏ cache)?

### 3. User chưa có thẻ mà bấm "Mua gói" → làm gì?

- **(a) Buộc thêm thẻ trước** (SetupIntent → rồi tạo sub): một luồng duy nhất, nhưng thêm một bước cho user mới.
- **(b) Fallback về Checkout như hiện tại**: giữ conversion cho user mới, nhưng **duy trì hai luồng mua song song vĩnh viễn** → mọi thay đổi về sau phải sửa hai chỗ.

### 4. Có gộp việc chuẩn hóa `incomplete` / `payment_intent.payment_failed` vào scope này không?

Cả hai đều là **lỗ hổng có sẵn** ([Flow 11](./billing-flows.md#flow-11--post-stripepayment-intent-không-nên-dùng): `Payment` kẹt `PENDING`), nhưng feature này sẽ **biến chúng từ hiếm thành thường xuyên**. Sửa cùng lúc, hay tách PR riêng?

---

## Không nằm trong phạm vi

- Ví điện tử / ACH / bank debit — chỉ `card`.
- Thẻ dùng chung theo team/organization.
- Lưu thẻ ở nhiều provider (`PaymentProvider` mới ngoài `STRIPE`).
- Cho phép tiêu credit ([vẫn là lỗ hổng #1](./billing-flows.md#1-tiêu-credit) của hệ thống).

---

## Chú thích ký hiệu

| Ký hiệu | Nghĩa |
|---|---|
| 🔴 | Rủi ro cao — mất tiền, mất gói, hoặc lỗ hổng bảo mật |
| 🟡 | Cần biết — hành vi bất ngờ hoặc nợ kỹ thuật |
| ✅ | Đã có sẵn / hành vi đúng |
