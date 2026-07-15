# Billing Refactor: Single-Subscription → Multi-Subscription

> **Trạng thái**: Đề xuất thiết kế — chưa triển khai code.
> **Ngày**: 2026-07-15
> **Phạm vi**: Domain model, entity relationship, Stripe integration, credit lifecycle, migration path.
>
> **Các quyết định đang chờ chốt** (xem §16):
> 1. Mỗi product = một Stripe Subscription riêng, hay gộp items trong một Stripe Subscription?
> 2. Free tier: giữ "free = subscription row" hay chuyển sang "free = fallback"? *(đề xuất: fallback — xem §14.1)*
> 3. Có kế hoạch B2B/team billing trong ~2 năm không (quyết định đưa `BillingAccount` vào từ Phase 0)?

---

## 1. Phân tích business model hiện tại

Chuỗi domain hiện tại:

```
User (1─1) Subscription (n─1) PricingOption (n─1) Plan
                                      └────(n─1) BillingCycle
User (1─1) CreditWallet (addonCredits: Int)
AddonPackage → Payment → grantAddonCredits
```

### Điểm mạnh đang có (nên giữ)

- **Webhook-driven, Stripe là source of truth** — `PaidInvoiceSyncService.applyPaidInvoice` là nơi duy nhất "sang kỳ" subscription và cấp credit, có claim idempotent trên invoice.
- **Ledger `CreditTransaction` với `idempotencyKey` unique** — mọi biến động credit đều có audit trail và chống trùng.
- **Tách reset credit khỏi billing cycle** — cron reset riêng (`credit-reset.cron.ts`) neo idempotency vào `nextCreditResetAt`, xử lý đúng case Yearly plan + monthly credit reset.
- **`PaymentAdapter` interface** đã có mầm provider abstraction.

### Điểm yếu cấu trúc

- **Số dư credit nằm trên hai chỗ khác bản chất nhau**: `Subscription.subscriptionCreditsRemaining` (state lifecycle trộn với state ledger) và `CreditWallet.addonCredits` (một số nguyên duy nhất, không nguồn gốc, không hạn dùng).
- **Plan vừa là catalog vừa là entitlement policy** (`renewalCredits`, `resetIntervalDay` nằm trên Plan).
- **Free plan là một row Subscription vật lý**, kéo theo cả một cron reconciliation (`free-plan-reconciliation.cron.ts`) chỉ để đảm bảo invariant "user nào cũng có đúng 1 subscription".

## 2. Các assumption đang bị hard-code

| # | Assumption | Bằng chứng trong code |
|---|-----------|----------------------|
| A1 | Một user có đúng 1 subscription | `Subscription.userId @unique` (schema.prisma); `subscription.update({ where: { userId } })` trong `credit.repository.ts`; `lockForConsume` SELECT theo `userId` kỳ vọng 1 row |
| A2 | Credit là một loại tiền tệ duy nhất, dùng chung mọi dịch vụ | `CreditWallet.addonCredits` là 1 số int; `ConsumeCmd` không có chiều "service/product" |
| A3 | Thứ tự tiêu cứng: Subscription trước, Add-on sau | `credit.service.ts` build sources theo thứ tự cố định |
| A4 | Quyền tiêu add-on phụ thuộc vào "cái plan duy nhất" của user | `isAddonUsable(planCode !== FREE && status ∈ {ACTIVE, TRIALING})` — với nhiều subscription, "planCode của user" không còn định nghĩa được |
| A5 | Chỉ có 2 plan code, hard-code | `PLAN_CODES = { FREE, PRO }` |
| A6 | Free = một Subscription row thật | `free-plan-reconciliation.cron.ts` + `free-plan-downgrade.service.ts` |
| A7 | Reset interval là "ngày chia 30 làm tròn thành tháng" | `Math.round(plan.resetIntervalDay / 30)` xuất hiện ở cả `credit-reset.cron.ts` và `paid-invoice-sync.service.ts` (logic nhân đôi; `resetIntervalDay = 45` âm thầm thành "1 tháng") |
| A8 | Trial chỉ là 2 timestamp trên Subscription, không có model grant riêng | `trialStart/trialEnd` |
| A9 | Grant thủ công (admin/gift) chỉ là `ADJUSTMENT` transaction, không expiry, không nguồn gốc | `CreditService.adjust` |
| A10 | Mọi subscription đều phải có Stripe subscription phía sau | Không có khái niệm billing mode nội bộ; Enterprise/Trial không qua Stripe không biểu diễn được |
| A11 | Idempotency key scope theo user là đủ | `creditKey.consume(userId, requestId)` — vẫn ổn, nhưng các key `sub:{subscriptionId}` cần giữ nguyên ngữ nghĩa khi có nhiều sub |

## 3. Domain model mới (tổng quan)

Tách thành **3 bounded context**:

```
┌─────────────── CATALOG ────────────────────────────────┐
│ Product ─< Plan ─< PricingOption >─ BillingCycle        │
│ Product ─< AddonPackage (one-time SKU)                  │
└─────────────────────────────────────────────────────────┘
                       │ mua
                       ▼
┌─────────────── BILLING (mirror Stripe) ─────────────────┐
│ Subscription (user × product, lifecycle)                │
│ Invoice, Payment, PaymentMethod, WebhookEvent           │
└─────────────────────────────────────────────────────────┘
                       │ sinh ra quyền lợi
                       ▼
┌────────────── ENTITLEMENT ──────────────────────────────┐
│ CreditGrant (bucket ledger: nguồn, số dư, hạn, priority)│
│ CreditTransaction (ledger bất biến)                     │
└─────────────────────────────────────────────────────────┘
```

Nguyên tắc trung tâm: **Billing trả lời "user đang trả tiền cho cái gì" (Stripe là source of truth); Entitlement trả lời "user được dùng bao nhiêu" (business rule riêng)**. Hai context nối một chiều qua webhook events — chính thức hóa triết lý hiện tại.

## 4. Entity relationship mới

```
User 1──n Subscription        (partial unique: 1 sub "live" / user / product)
User 1──n CreditGrant         (thay cho subscriptionCreditsRemaining + CreditWallet)
User 1──n CreditTransaction   (mỗi transaction trỏ về 1 CreditGrant)

Product 1──n Plan
Product 1──n AddonPackage
Plan 1──n PricingOption n──1 BillingCycle
Plan 1──1 CreditPolicy        (renewalCredits, resetInterval — tách khỏi Plan)

Subscription n──1 PricingOption
Subscription 1──n Invoice 1──n Payment
Subscription 1──n SubscriptionEvent
Subscription 1──n CreditGrant (grant loại SUBSCRIPTION trỏ về sub sinh ra nó)
```

### CreditGrant — thay đổi lớn nhất

| Trường | Ý nghĩa |
|---|---|
| `userId`, `productId` (nullable) | `productId` null = credit universal, dùng cho mọi product |
| `sourceType` | `SUBSCRIPTION` / `ADDON` / `TRIAL` / `GIFT` / `PROMOTION` / `ADMIN` |
| `sourceRef` | subscriptionId / paymentId / campaignId / adminUserId |
| `amountGranted`, `amountRemaining` | CHECK `remaining >= 0 AND remaining <= granted` |
| `expiresAt` (nullable) | Subscription credits hết hạn theo reset; add-on null (hoặc theo policy); gift/promo có hạn |
| `priority` | Điều khiển thứ tự tiêu bằng data thay vì code (thay A3) |

**Consume** trở thành: lock các grant còn hiệu lực của (user, product) theo thứ tự `priority ASC, expiresAt ASC NULLS LAST, id ASC`, drain lần lượt, ghi transaction cho từng grant. Thuật toán `allocateCredits` hiện tại giữ nguyên, chỉ đổi nguồn từ 2 bucket cứng thành n grant.

## 5. Product — có, và là gốc của Catalog

Không có Product thì "nhiều subscription" chỉ enforce được bằng convention trên Plan code (`AI_PRO`, `OCR_PRO`) — chính là loại hard-code cần thoát. Product cần tồn tại vì:

1. **Là đơn vị của invariant quan trọng nhất**: "một user chỉ có một subscription live *per product*" — không có Product thì không viết được constraint này ở DB.
2. **Là chiều của credit**: khi AI credits ≠ OCR credits, `CreditGrant.productId` cần FK thật.
3. **Là ranh giới provisioning**: kích hoạt AI khác kích hoạt Storage.

Product nằm ở **đỉnh của Catalog**: `Product → Plan → PricingOption`. Product **không** map sang Stripe (Stripe Product ≈ Plan của mình); nó thuần nội bộ.

Trường gợi ý: `code` (AI, STORAGE, OCR), `name`, `entitlementType` (`CREDIT` / `QUOTA` / `SEAT` — Storage bản chất là quota chứ không phải credit tiêu dần, xem §14), `isActive`.

Trade-off: thêm 1 tầng join cho query catalog — chấp nhận được, catalog nhỏ và cache được.

## 6. Plan đại diện cho điều gì?

**Plan = một tier thương mại của một Product** (AI Free, AI Pro, Storage Basic...). Trả lời "user mua *mức* nào", không trả lời "trả bao nhiêu, chu kỳ nào" (việc của PricingOption), không trực tiếp trả lời "được cấp bao nhiêu credit".

Đề xuất tách entitlement policy khỏi Plan (`CreditPolicy` gắn 1-1 với Plan): `creditAmount`, `resetInterval` dạng tường minh (`MONTHLY` / `EVERY_N_DAYS`) thay cho heuristic `resetIntervalDay / 30` (fix A7). Product loại QUOTA thì policy là `quotaAmount` thay vì credit.

Phản biện: giữ plan Free là được, nhưng logic không được so sánh code cứng — thay bằng thuộc tính trên Plan (`isFree: boolean` hoặc `tier: 0`).

## 7. PricingOption đại diện cho điều gì?

**PricingOption = SKU có thể mua = Plan × BillingCycle × (currency, provider)**, map **1-1 với một Stripe Price**. Đơn vị duy nhất xuất hiện trong checkout, upgrade, invoice line. Giữ nguyên vai trò hiện tại, bổ sung:

- Unique `(planId, billingCycleId, currency, provider)` — không có 2 SKU trùng nghĩa cùng active.
- `providerPriceId` unique per provider.

PricingOption **không** chứa business rule credit — chỉ là giá.

## 8. Subscription đại diện cho điều gì?

**Subscription = hợp đồng gia hạn định kỳ của một User trên một Product, ở một PricingOption, lifecycle đồng bộ từ nguồn billing.** Thay đổi so với hiện tại:

- Bỏ `userId @unique` → thêm `productId` (denormalize từ `pricingOption.plan.productId` để làm constraint, §13) + partial unique index.
- **Bỏ `subscriptionCreditsRemaining`** — số dư dời sang CreditGrant. Subscription chỉ giữ lifecycle: status, period, `nextCreditResetAt`, provider refs, trial window.
- Thêm `billingMode: PROVIDER | MANUAL | NONE` — mở đường cho Enterprise (hóa đơn tay) và internal trial không cần Stripe sub giả (fix A10). `providerSubscriptionId` bắt buộc khi `PROVIDER`, cấm khi khác.

### Quyết định Stripe: mỗi Subscription nội bộ = một Stripe Subscription riêng

(Không dồn nhiều product vào một Stripe Subscription nhiều items.)

- **Ưu**: lifecycle độc lập (hủy OCR không đụng AI), webhook mapping 1-1 như hiện nay, `paid-invoice-sync` gần như giữ nguyên logic, proration đơn giản.
- **Nhược**: user 3 sản phẩm nhận 3 invoice/tháng, 3 lần charge thẻ.
- Phương án items-trong-1-sub cho invoice gộp đẹp hơn nhưng webhook sync phức tạp gấp nhiều lần (một `invoice.paid` fan-out ra nhiều local subscription; cancel một item là `subscription.updated` chứ không phải `deleted`...). Với quy mô hiện tại, invoice gộp không đáng giá đó. Có thể align `billing_cycle_anchor` để các invoice rơi cùng ngày.

### Ngữ nghĩa row: "slot" hay "contract instance"?

Vấn đề phát hiện khi review: nếu mỗi lần đổi gói tạo row mới **và Free cũng là row**, thì chuỗi Free → Pro → Free để lại rác: 2 row Free (1 inactive) + 1 row Pro inactive.

| | Model A — Slot | Model B — Contract instance |
|---|---|---|
| Định nghĩa | Mỗi user × product có đúng 1 row, sống mãi, mutate tại chỗ | Mỗi lần đăng ký là row mới; row cũ terminal |
| Free → Pro → Free | 1 row duy nhất, mutate `pricingOptionId` | 3 row nếu Free là row; 1 row nếu Free là fallback |
| Lịch sử | Nằm ở `SubscriptionEvent` | Nằm ở chính các row + events |
| Stripe mapping | `providerSubscriptionId` bị viết đè ("repoint") khi Stripe sub mới xuất hiện | Row map 1-1 vĩnh viễn với một Stripe Subscription ID |
| Constraint | Unique đầy đủ `(userId, productId)` | Partial unique `(userId, productId) WHERE status ∈ live` |
| Hiện trạng | Đây là model đang chạy (`paid-invoice-sync` repoint row hiện có) | — |

**Đề xuất: Model B + Free = fallback (không row)** — hai quyết định phải đi cùng nhau:

1. Row map 1-1 vĩnh viễn với Stripe Subscription ID → xóa được toàn bộ logic "repoint" (`shouldRepoint`/`isStale` trong `paid-invoice-sync.service.ts` là code bù đắp cho việc slot model lệch pha với Stripe).
2. Invoice/Payment lịch sử trỏ về đúng hợp đồng sinh ra nó, không bị "viết đè quá khứ" khi slot đổi giá.
3. Đúng webhook-as-source-of-truth: `customer.subscription.created` = tạo row, `deleted` = terminal row. Mapping 1-1, không trạng thái lai.
4. Free không phải hợp đồng (không Stripe sub, không invoice) → không đáng một row; loại Free khỏi bảng Subscription thì row terminal còn lại đều là lịch sử thanh toán thật, không có rác.

**Ranh giới quan trọng**: upgrade/downgrade tier trong cùng một Stripe subscription (đổi price qua proration — flow `upgradeSubscriptionTier` hiện tại) vẫn là *update trên cùng row*, vì Stripe sub ID không đổi. **Row mới khi và chỉ khi Stripe subscription mới.** Sau khi set, `providerSubscriptionId` là immutable.

Kịch bản Free → Pro → hủy với thiết kế này: không row → 1 row Pro ACTIVE → row đó CANCELLED, user rơi về free fallback. Tổng cộng **1 row, là lịch sử thật**.

Cái giá phải trả:
- Free tier có credit định kỳ → grant free phải neo theo **User** (cron quét user không có sub live, idempotency key theo `userId + kỳ`), vì không còn `nextCreditResetAt` trên row Free.
- API `GET /subscription` phải trả trạng thái "free" tổng hợp dù DB không có row — thêm lớp compose khi đọc.
- Migration phải convert/xóa các row Free hiện hữu.

Đổi lại: xóa được `free-plan-downgrade.service` và phần lớn `free-plan-reconciliation.cron`.

## 9. CreditWallet: refactor — thay bằng CreditGrant ledger

Giữ nguyên CreditWallet sẽ chết ở 3 điểm: (1) không có chiều product, (2) không có expiry → không làm được Gift/Promo tử tế, (3) `isAddonUsable` gate theo "plan duy nhất của user" — vô nghĩa khi có nhiều sub (A4).

Thay bằng **CreditGrant** (§4). "Wallet" vẫn tồn tại như **khái niệm đọc** (view/API tổng hợp `SUM(amountRemaining) GROUP BY productId, sourceType`), không còn là bảng ghi.

**Phản biện business rule `isAddonUsable`**: user đã trả tiền mua add-on credits nhưng bị khóa khi rơi về Free — dễ gây khiếu nại, bản chất là dùng add-on làm đòn bẩy giữ subscription. Nếu vẫn giữ, biến nó thành **policy tường minh trên Product** (`addonRequiresLiveSubscription: boolean`) và định nghĩa lại theo product: add-on credits của AI cần sub AI live, không liên quan sub OCR. Khi bị khóa, credit nên **đóng băng** (grant còn đó, không tiêu được) chứ không expire.

## 10. Add-on Subscription vs One-time Add-on

Ranh giới: **cái gì gia hạn định kỳ mới là Subscription**.

| | One-time Add-on | Recurring Add-on |
|---|---|---|
| Catalog | `AddonPackage` (thuộc Product) | Là một **Plan** riêng của Product, có PricingOption |
| Stripe | PaymentIntent / one-time Price | Stripe Subscription riêng |
| Kết quả | 1 `CreditGrant(sourceType=ADDON)`, cấp một lần | `CreditGrant(sourceType=SUBSCRIPTION)` cấp lại mỗi kỳ qua `invoice.paid` — dùng chung pipeline với sub thường |
| Lifecycle | Không có — chỉ có Payment | Có Subscription row, status, cancel... |

"Recurring add-on" **không cần model mới** — chỉ là một Subscription trên một Plan có tính chất bổ trợ. Nếu cần ràng buộc "recurring add-on chỉ tồn tại khi có base subscription": thêm `Subscription.parentSubscriptionId` nullable + rule hủy cascade khi base bị hủy (enforce ở application + event).

## 11. Trial, Enterprise, Promotion, Gift

Nguyên tắc: **có lifecycle gia hạn → Subscription; là "một cục quyền lợi có hạn dùng" → CreditGrant**. Không tạo subscription giả cho quà tặng.

| Loại | Model | Ghi chú |
|---|---|---|
| Trial (self-serve) | Trạng thái/phase của Subscription (`TRIALING` + `trialStart/End`) | Delegate cho Stripe trial như hiện tại |
| Enterprise Trial / contract | Subscription với `billingMode = MANUAL` (hoặc `NONE` cho trial) | Không Stripe sub phía sau; hết hạn bằng cron nội bộ. Lý do cần `billingMode` |
| Promotion giảm giá | Stripe Coupon/PromotionCode | Không tự làm lại tầng discount; chỉ mirror kết quả qua invoice |
| Promotion tặng credit | `CreditGrant(sourceType=PROMOTION)` | Có `expiresAt`, `sourceRef=campaignId` |
| Gift / Admin Grant | `CreditGrant(sourceType=GIFT/ADMIN)` | `expiresAt`, `sourceRef` ghi ai cấp + lý do. Thay thế `CreditService.adjust` kiểu ADJUSTMENT vô danh (A9) |

Mọi loại tiêu qua **một đường consume duy nhất** nhờ `priority` + `expiresAt` trên grant (ví dụ: promo hết hạn sớm tiêu trước; add-on trả tiền tiêu cuối). Business rule "tiêu cái nào trước" trở thành data.

## 12. Migration path (expand → migrate → contract)

**Phase 0 — Expand schema, không đổi hành vi:**
1. Tạo `Product`, seed 1 row (vd `AI`). Thêm `Plan.productId`, backfill.
2. Thêm `Subscription.productId` (backfill), `billingMode = PROVIDER` default.
3. Tạo bảng `CreditGrant` + thêm `CreditTransaction.grantId` nullable.

**Phase 1 — Backfill ledger** (batch, lock từng user):
- Mỗi Subscription có `subscriptionCreditsRemaining > 0` → 1 CreditGrant `SUBSCRIPTION` với `amountRemaining` = số dư, `expiresAt = nextCreditResetAt`.
- Mỗi CreditWallet có `addonCredits > 0` → 1 CreditGrant `ADDON`, không expiry.
- Đối chiếu: `SUM(grants) == SUM(cột cũ)` per user trước khi sang phase sau.

**Phase 2 — Chuyển writer/reader:**
- `CreditRepository` đổi sang đọc/ghi CreditGrant; giai đoạn chuyển tiếp dual-write cột cũ + grant trong cùng transaction, kèm cron reconcile so lệch (pattern reconciliation đã có sẵn).
- Webhook sync (`paid-invoice-sync`) đổi từ "update cột" sang "expire grant cũ + tạo grant mới" — idempotency key giữ format `grant_sub_{invoiceId}` nên webhook replay từ trước migration vẫn an toàn.

**Phase 3 — Nhả constraint 1-1** *(point-of-no-return về API)*:
- Drop `Subscription.userId @unique`, tạo partial unique index (§13).
- Cần versioning endpoint trước bước này (client đang giả định `GET /subscription` trả 1 object).
- Nếu chốt "Free = fallback": convert các row Free hiện hữu (xóa row, user rơi về fallback; credit free còn lại chuyển thành CreditGrant neo theo user).

**Phase 4 — Contract:**
- Drop `subscriptionCreditsRemaining`, drop `CreditWallet`.
- Xóa `isAddonUsable`/`PLAN_CODES` hard-code, `free-plan-downgrade.service`, phần free-sub của reconciliation cron.

Backward compatibility: user cũ chỉ có product AI; endpoint cũ trả "subscription live của product mặc định" trong thời gian deprecate.

## 13. Business rule enforce bằng DB constraint

1. **Một sub live per user per product**: `CREATE UNIQUE INDEX ... ON "Subscription"(userId, productId) WHERE status IN ('ACTIVE','TRIALING','PAST_DUE','INCOMPLETE','PAUSED')`. Phải denormalize `productId` vào Subscription vì Postgres không index xuyên join.
2. **Không âm credit**: `CHECK (amountRemaining >= 0)` và `CHECK (amountRemaining <= amountGranted)` trên CreditGrant — tuyến phòng thủ cuối sau lock logic.
3. **Stripe mapping duy nhất**: unique `(provider, providerSubscriptionId)`; unique `(provider, providerPriceId)` trên PricingOption; unique `providerInvoiceId` (đã có); unique `providerPaymentId` (đã có). Với Model B: `providerSubscriptionId` immutable sau khi set (enforce ở application/trigger).
4. **billingMode nhất quán**: `CHECK ((billingMode = 'PROVIDER') = (providerSubscriptionId IS NOT NULL))`.
5. **Grant hợp lệ**: `CHECK (sourceType <> 'SUBSCRIPTION' OR sourceRef IS NOT NULL)`; FK `CreditTransaction.grantId → CreditGrant`.
6. **Idempotency**: giữ unique `idempotencyKey` — constraint quan trọng nhất hệ thống, không đụng.
7. **Catalog**: unique `(planId, billingCycleId, currency, provider)` trên PricingOption; unique `Plan(productId, code)`.

## 14. Edge cases phải xử lý

- **Lock ordering / deadlock**: consume giờ lock n grant thay vì 2 row cố định. Bắt buộc lock theo thứ tự ổn định (`ORDER BY id FOR UPDATE`), nếu không hai request song song cùng user có thể deadlock. (Bài học `FOR UPDATE OF s` trong `lockForConsume` sẽ quay lại ở dạng mới.)
- **Consume song song với reset**: reset = expire grant cũ + tạo grant mới; hai phía phải lock cùng thứ tự. Idempotency key theo `nextCreditResetAt` hiện tại vẫn đúng.
- **Webhook out-of-order giữa các sub**: mọi so sánh stale phải theo `subscriptionId` cụ thể — sync hiện tại đã nhận `subscriptionId` param, đúng hướng.
- **User hủy sub product A nhưng còn add-on credits của A**: policy `addonRequiresLiveSubscription` per product phải rõ (§9); credit **đóng băng** chứ không mất.
- **Upgrade cross-product không tồn tại**: upgrade chỉ trong phạm vi một product; API phải chặn `newPricingOptionId` thuộc product khác (hiện `upgradeSubscriptionTier` không có check này vì trước giờ không thể xảy ra).
- **Storage không phải credit**: Storage là quota liên tục (dùng 8/10GB), không phải số tiêu dần. Ép Storage vào credit model sẽ méo — vì vậy Product cần `entitlementType`, Storage đi nhánh Quota thay vì CreditGrant. *(Phản biện đề bài: đừng giả định mọi product đều là credit.)*
- **Trial abuse**: nhiều product = nhiều cửa trial; cần "một trial per user per product trọn đời" (bảng ghi nhận trial đã dùng, không xóa theo subscription).
- **Nhiều PaymentMethod, nhiều sub**: N Stripe sub cùng customer dùng chung default payment method — một thẻ chết làm N sub PAST_DUE cùng lúc; dunning UX phải gom theo user, không theo sub.

### 14.1. Free tier: fallback thay vì row

Đã phân tích chi tiết ở §8. Tóm tắt: giữ "free = subscription row" cho N product nghĩa là N row + N cron reconcile mỗi user, và sinh rác row khi chuyển gói (Free → Pro → Free). Đề xuất **"không có sub live = hưởng free tier"** — free là fallback khi đọc entitlement. Trade-off duy nhất đáng kể: free credit định kỳ phải grant theo User bằng cron riêng.

## 15. Kiến trúc 5 năm

1. **Ba context (§3) giữ ranh giới cứng**: module NestJS riêng, giao tiếp qua service interface + domain event, không import chéo Prisma model. Sau này cần tách service thì cắt theo đường này.
2. **Entitlement layer là API nội bộ duy nhất** mà các product service (AI, OCR...) gọi: `checkAndConsume(userId, productCode, amount, idempotencyKey)` và `getEntitlements(userId, productCode)`. Product service không bao giờ nhìn thấy Subscription/Stripe — đổi pricing model, thêm provider, usage-based về sau không lan ra ngoài billing.
3. **Hoàn thiện `PaymentAdapter`**: thêm provider mới (VNPay/MoMo...) chỉ là adapter + webhook mapper mới, domain không đổi.
4. **Đường tiến hóa đã chừa sẵn**: usage-based billing = thêm `UsageRecord` đổ vào consume pipeline; seat-based = `entitlementType=SEAT`; credit per-product đã có chiều `productId`; grant expiry đã có sẵn cho mọi chương trình marketing.
5. **Cố tình KHÔNG làm bây giờ** (YAGNI có chủ đích): multi-currency wallet; tax engine riêng (Stripe Tax lo); multi-tenant/organization billing — **trừ khi** có kế hoạch B2B thật trong 1–2 năm thì đưa `BillingAccount` (chủ thể billing thay cho User) vào ngay Phase 0, vì đổi chủ thể sau này đắt gấp 10.

## 16. Các quyết định cần chốt

| # | Quyết định | Đề xuất | Trạng thái |
|---|-----------|---------|-----------|
| D1 | Stripe: một Stripe Subscription per product, hay gộp items? | Một Stripe Subscription riêng per product (§8) | Chờ chốt |
| D2 | Free tier: row hay fallback? | Fallback, đi cùng Model B contract-instance (§8, §14.1) | Chờ chốt |
| D3 | Row semantics: slot (A) hay contract instance (B)? | Model B — row mới khi và chỉ khi Stripe subscription mới | Chờ chốt (đi cùng D2) |
| D4 | `BillingAccount` từ Phase 0? | Chỉ khi có kế hoạch B2B trong 1–2 năm | Chờ thông tin business |
