# Billing Refactor: Single-Subscription → Multi-Subscription

> **Trạng thái**: Thiết kế đã chốt toàn bộ (D1–D12, xem §16) — chưa triển khai code.
> **Ngày**: 2026-07-15
> **Phạm vi**: Domain model, entity relationship, Stripe integration, credit lifecycle, migration path.
>
> **Đã chốt (2026-07-16)** — toàn bộ quyết định D1–D12, chi tiết §16:
> 1. **D1**: Mỗi product = một Stripe Subscription riêng, không gộp items. Thẻ đã lưu (default payment method) tự trừ từng subscription — nhiều invoice/tháng là chấp nhận được (§8).
> 2. **D2 + D3**: Row semantics = Model B (contract instance) **và Free cũng là một subscription row** — mỗi user × product luôn có đúng 1 row live, row cũ chuyển terminal để giữ history tường minh (§8, §14.1).
> 3. **D4**: Không có kế hoạch B2B/team billing → **không** đưa `BillingAccount` vào.
> 4. **D5**: Credit/add-on **luôn thuộc về một product cụ thể** (mua 1000 credit AI, 1000GB Storage...) — không có credit universal dùng chéo product.
> 5. **D6 — phạm vi hiện tại**: chỉ có product **AI**, Free plan chỉ tồn tại cho AI. OCR/Storage là hướng mở tương lai — không build trước, cấu trúc bảng chỉ chỉnh khi thật sự cần (§5, §15).
> 6. **D7–D9 (policy)**: add-on credits đóng băng khi rớt về Free (§9); hủy gia hạn = sống đến hết kỳ, hủy ngay = mất gói ngay; PAST_DUE ân hạn 3 ngày (retry 3 lần, 1 lần/ngày) — trong ân hạn **đóng băng toàn bộ credit** (cả subscription lẫn add-on), hết ân hạn rớt Free (§14.2).
> 7. **D10–D12**: không có upgrade giữa kỳ (catalog chỉ FREE/PRO); **bỏ trial hoàn toàn**; **không refund** gói đã mua — tính sau nếu business cần.

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
- **Free plan là một row Subscription vật lý**, kéo theo cả một cron reconciliation (`free-plan-reconciliation.cron.ts`) chỉ để đảm bảo invariant "user nào cũng có đúng 1 subscription". *(Cập nhật 2026-07-16: đã chốt giữ "Free = row" có chủ đích để lưu history — xem §8, §14.1; cron reconciliation giữ lại và generalize theo product.)*

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
| `userId`, `productId` (bắt buộc) | Credit luôn thuộc về đúng một product (đã chốt D5 — không có credit universal) |
| `sourceType` | `SUBSCRIPTION` / `ADDON` / `GIFT` / `PROMOTION` / `ADMIN` (không có `TRIAL` — đã bỏ trial, D12) |
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

Trường Phase 0: `code` (hiện tại seed đúng 1 row `AI`), `name`, `isActive`. **Chưa thêm** `entitlementType` (`CREDIT` / `QUOTA` / `SEAT`) — phạm vi hiện tại mọi product đều là credit, cột này chỉ đưa vào khi thật sự làm product dạng khác (Storage là quota chứ không phải credit tiêu dần, xem §14). Đã chốt D6: không build trước cho OCR/Storage.

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
- **Bỏ `subscriptionCreditsRemaining`** — số dư dời sang CreditGrant. Subscription chỉ giữ lifecycle: status, period, `nextCreditResetAt`, provider refs. (`trialStart`/`trialEnd` bỏ luôn — D12: không dùng trial.)
- Thêm `billingMode: PROVIDER | MANUAL | NONE` — mở đường cho Enterprise (hóa đơn tay) và là mode của row Free (fix A10). `providerSubscriptionId` bắt buộc khi `PROVIDER`, cấm khi khác.

### Quyết định Stripe (đã chốt 2026-07-16): mỗi Subscription nội bộ = một Stripe Subscription riêng

(Không dồn nhiều product vào một Stripe Subscription nhiều items.)

- **Ưu**: lifecycle độc lập (hủy OCR không đụng AI), webhook mapping 1-1 như hiện nay, `paid-invoice-sync` gần như giữ nguyên logic, proration đơn giản.
- **Nhược (chấp nhận)**: user 3 sản phẩm nhận 3 invoice/tháng, 3 lần charge thẻ — không đáng ngại vì thẻ đã lưu làm default payment method, Stripe tự trừ từng subscription, user không phải thao tác gì thêm.
- Phương án items-trong-1-sub (đã bác) cho invoice gộp đẹp hơn nhưng webhook sync phức tạp gấp nhiều lần (một `invoice.paid` fan-out ra nhiều local subscription; cancel một item là `subscription.updated` chứ không phải `deleted`...). Với quy mô hiện tại, invoice gộp không đáng giá đó. Nếu muốn, có thể align `billing_cycle_anchor` để các invoice rơi cùng ngày.

### Ngữ nghĩa row: "slot" hay "contract instance"?

Nếu mỗi lần đổi gói tạo row mới **và Free cũng là row**, chuỗi Free → Pro → Free để lại 3 row (1 Free live + 1 Free terminal + 1 Pro terminal). Đây không phải rác — đây chính là lịch sử chuyển gói tường minh, và là lý do chọn multi-row (xem quyết định bên dưới).

| | Model A — Slot | Model B — Contract instance |
|---|---|---|
| Định nghĩa | Mỗi user × product có đúng 1 row, sống mãi, mutate tại chỗ | Mỗi lần đăng ký là row mới; row cũ terminal |
| Free → Pro → Free | 1 row duy nhất, mutate `pricingOptionId` | 3 row nếu Free là row; 1 row nếu Free là fallback |
| Lịch sử | Nằm ở `SubscriptionEvent` | Nằm ở chính các row + events |
| Stripe mapping | `providerSubscriptionId` bị viết đè ("repoint") khi Stripe sub mới xuất hiện | Row map 1-1 vĩnh viễn với một Stripe Subscription ID |
| Constraint | Unique đầy đủ `(userId, productId)` | Partial unique `(userId, productId) WHERE status ∈ live` |
| Hiện trạng | Đây là model đang chạy (`paid-invoice-sync` repoint row hiện có) | — |

**Đã chốt (2026-07-16): Model B + Free là row**:

1. Row map 1-1 vĩnh viễn với Stripe Subscription ID → xóa được toàn bộ logic "repoint" (`shouldRepoint`/`isStale` trong `paid-invoice-sync.service.ts` là code bù đắp cho việc slot model lệch pha với Stripe).
2. Invoice/Payment lịch sử trỏ về đúng hợp đồng sinh ra nó, không bị "viết đè quá khứ" khi slot đổi giá.
3. Đúng webhook-as-source-of-truth: `customer.subscription.created` = tạo row, `deleted` = terminal row. Mapping 1-1, không trạng thái lai.
4. **Free là row để history tường minh**: toàn bộ lịch sử gói của user đọc thẳng từ bảng Subscription bằng một query, không phải compose từ `SubscriptionEvent` + khoảng trống giữa các row trả tiền. Lợi ích kèm theo: `nextCreditResetAt` cho free credit vẫn neo trên row → cron reset credit đi **một đường duy nhất** cho cả Free lẫn trả tiền, không cần cron grant riêng theo User.

**Lifecycle row Free** (quy tắc "luôn đúng 1 live, còn lại inactive"):

- User mới (hoặc lần đầu chạm một product) → tạo row Free `ACTIVE`, `billingMode = NONE`, `providerSubscriptionId = null`.
- Free → Pro: row Free chuyển `EXPIRED` (terminal), row Pro mới tạo từ webhook `customer.subscription.created`.
- Pro → hủy/hết hạn: row Pro chuyển `CANCELLED`/`EXPIRED` (terminal), tạo **row Free mới** `ACTIVE` — không revive row Free cũ, giữ nguyên tắc "row là contract instance, đã terminal thì bất biến".
- Invariant: mỗi user × product có **đúng 1 row live** — partial unique index (§13) áp dụng cho cả Free. `free-plan-reconciliation.cron` giữ lại làm lưới an toàn cho invariant này, generalize theo product.

**Ranh giới quan trọng**: upgrade/downgrade tier trong cùng một Stripe subscription (đổi price qua proration — flow `upgradeSubscriptionTier` hiện tại) vẫn là *update trên cùng row*, vì Stripe sub ID không đổi. Với row trả tiền: **row mới khi và chỉ khi Stripe subscription mới**; với row Free: row mới khi user rơi về free. Sau khi set, `providerSubscriptionId` là immutable (row Free không bao giờ set).

Kịch bản Free → Pro → hủy với thiết kế này: Free ACTIVE → Free EXPIRED + Pro ACTIVE → Pro CANCELLED + Free mới ACTIVE. Tổng cộng **3 row, toàn bộ là lịch sử chuyển gói tường minh**.

Cái giá phải trả (chấp nhận có chủ đích):
- Số row tăng theo số lần chuyển gói × số product; bảng Subscription chứa cả row không gắn với hợp đồng billing thật.
- "Row mới ⇔ Stripe subscription mới" không còn tuyệt đối — row Free đứng ngoài mapping Stripe; constraint `billingMode` (§13.4) phải cho phép nhánh `NONE`.
- Giữ `free-plan-reconciliation.cron` (không xóa được như phương án fallback), nhân theo product khi multi-product.

Đổi lại: không cần cron grant free credit theo User, không cần lớp compose "free ảo" cho `GET /subscription`, migration không phải convert/xóa row Free hiện hữu.

## 9. CreditWallet: refactor — thay bằng CreditGrant ledger

Giữ nguyên CreditWallet sẽ chết ở 3 điểm: (1) không có chiều product, (2) không có expiry → không làm được Gift/Promo tử tế, (3) `isAddonUsable` gate theo "plan duy nhất của user" — vô nghĩa khi có nhiều sub (A4).

Thay bằng **CreditGrant** (§4). "Wallet" vẫn tồn tại như **khái niệm đọc** (view/API tổng hợp `SUM(amountRemaining) GROUP BY productId, sourceType`), không còn là bảng ghi.

**Phản biện business rule `isAddonUsable`**: user đã trả tiền mua add-on credits nhưng bị khóa khi rơi về Free — dễ gây khiếu nại, bản chất là dùng add-on làm đòn bẩy giữ subscription. Nếu vẫn giữ, biến nó thành **policy tường minh trên Product** (`addonRequiresLiveSubscription: boolean`) và định nghĩa lại theo product: add-on credits của AI cần sub AI live, không liên quan sub OCR. Khi bị khóa, credit nên **đóng băng** (grant còn đó, không tiêu được) chứ không expire.

**Đã chốt (2026-07-16, D7)**: giữ rule theo đúng hướng này — AI có `addonRequiresLiveSubscription = true`. User rớt về Free AI thì add-on grant **đóng băng**: không tiêu được, không mất, không expire; tự khả dụng lại khi có sub AI trả tiền live.

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
| Trial (self-serve) | **Bỏ (D12)** | Không cung cấp trial — không dùng Stripe trial, không `trialStart/End`, không sourceType `TRIAL` |
| Enterprise contract | Subscription với `billingMode = MANUAL` | Không Stripe sub phía sau; hết hạn bằng cron nội bộ. Lý do cần `billingMode` |
| Promotion giảm giá | Stripe Coupon/PromotionCode | Không tự làm lại tầng discount; chỉ mirror kết quả qua invoice |
| Promotion tặng credit | `CreditGrant(sourceType=PROMOTION)` | Có `expiresAt`, `sourceRef=campaignId` |
| Gift / Admin Grant | `CreditGrant(sourceType=GIFT/ADMIN)` | `expiresAt`, `sourceRef` ghi ai cấp + lý do. Thay thế `CreditService.adjust` kiểu ADJUSTMENT vô danh (A9) |

Mọi loại tiêu qua **một đường consume duy nhất** nhờ `priority` + `expiresAt` trên grant (ví dụ: promo hết hạn sớm tiêu trước; add-on trả tiền tiêu cuối). Business rule "tiêu cái nào trước" trở thành data.

## 12. Migration path (expand → migrate → contract)

**Phase 0 — Expand schema, không đổi hành vi:**
1. Tạo `Product`, seed đúng 1 row `AI` (D6 — không seed OCR/Storage). Thêm `Plan.productId`, backfill.
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
- Free = row (đã chốt): các row Free hiện hữu **giữ nguyên**, chỉ backfill `productId` + set `billingMode = NONE`; credit free còn lại backfill thành CreditGrant `SUBSCRIPTION` trỏ về row Free như mọi subscription khác.

**Phase 4 — Contract:**
- Drop `subscriptionCreditsRemaining`, drop `CreditWallet`, drop `trialStart`/`trialEnd` (D12 — bỏ trial).
- Xóa `isAddonUsable`/`PLAN_CODES` hard-code (thay bằng `Plan.isFree` + policy per product). `free-plan-downgrade.service` và `free-plan-reconciliation.cron` **giữ lại**, refactor thành "tạo row Free mới khi row trả tiền terminal" + generalize theo product (Free = row đã chốt).

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
- **User hủy sub product A nhưng còn add-on credits của A**: đã chốt D7 — credit **đóng băng** chứ không mất (`addonRequiresLiveSubscription = true` cho AI, xem §9).
- **Upgrade cross-product không tồn tại**: upgrade chỉ trong phạm vi một product; API phải chặn `newPricingOptionId` thuộc product khác (hiện `upgradeSubscriptionTier` không có check này vì trước giờ không thể xảy ra).
- **Storage không phải credit** *(ghi chú tương lai — chưa làm, xem D6)*: Storage là quota liên tục (dùng 8/10GB), không phải số tiêu dần. Nếu sau này làm Storage thì mới thêm `entitlementType` cho Product và đi nhánh Quota thay vì CreditGrant — không thêm cột trước. *(Phản biện đề bài: đừng giả định mọi product đều là credit.)*
- **Trial abuse**: không còn — đã bỏ trial hoàn toàn (D12).
- **Nhiều PaymentMethod, nhiều sub**: N Stripe sub cùng customer dùng chung default payment method — một thẻ chết làm N sub PAST_DUE cùng lúc; dunning UX phải gom theo user, không theo sub.

### 14.1. Free tier: row (đã chốt 2026-07-16) — không dùng fallback

**Free là một subscription row.** Phương án fallback ("không có sub live = hưởng free tier") từng được đề xuất để tránh row Free tích lũy khi chuyển gói, nhưng bị bác vì mục tiêu chính của multi-row là **history tường minh**: chuỗi Free → Pro → Free đọc thẳng từ bảng Subscription, không phải suy từ khoảng trống giữa các row trả tiền. Lợi ích kèm theo: `nextCreditResetAt` neo trên row Free → một đường cron reset credit duy nhất cho mọi tier, không cần cron grant free credit theo User. Chi phí chấp nhận: giữ reconciliation cron, và row Free là ngoại lệ của mapping Stripe (`billingMode = NONE`, không `providerSubscriptionId` — xem §8).

**Phạm vi hiện tại (D6)**: Free plan chỉ tồn tại cho product **AI** — mỗi user có đúng 1 row Free (AI) khi không có sub AI trả tiền. Product tương lai (OCR/Storage) có free tier hay không sẽ quyết định khi làm product đó; không tạo sẵn row Free cho product chưa ra mắt.

### 14.2. Hủy gói và dunning (đã chốt 2026-07-16 — D8, D9)

**Hủy gói — hai đường, ngữ nghĩa khác nhau:**

- **Hủy gia hạn** (mặc định, map `cancel_at_period_end = true` phía Stripe): subscription và credit subscription **sống đến hết `currentPeriodEnd`** — user đã trả tiền cho cả kỳ. Cuối kỳ, webhook `customer.subscription.deleted` → row chuyển `CANCELLED` (terminal), credit subscription còn lại expire, tạo row Free mới, add-on credit đóng băng (D7).
- **Hủy ngay** (cancel immediately): **mất gói tại chỗ** — Stripe sub hủy ngay, row terminal ngay, credit subscription expire ngay, rớt về Free ngay. Không hoàn tiền phần kỳ còn lại (D11: không refund).

**Dunning (PAST_DUE) — ân hạn 3 ngày:**

- Invoice gia hạn charge thất bại → sub chuyển `PAST_DUE`; retry **3 lần trong 3 ngày (mỗi ngày 1 lần)** — cấu hình retry schedule phía Stripe, mirror trạng thái qua webhook `invoice.payment_failed` (đếm `attempts` trên Invoice như hiện tại).
- Trong ân hạn: **đóng băng toàn bộ credit** — cả credit subscription lẫn add-on đều không tiêu được (grant còn nguyên, không mất, không expire). Consume của product đó chỉ được phép khi sub live ở trạng thái `ACTIVE`. *Lưu ý: đây là thay đổi so với hành vi hiện tại — code hiện nay vẫn cho tiêu subscription credit khi `PAST_DUE`.*
- Retry lần 3 thất bại (hết ngày 3) → row chuyển terminal (`EXPIRED`), tạo row Free mới, credit subscription còn lại expire, add-on tiếp tục đóng băng (D7). Thanh toán thành công giữa chừng → về `ACTIVE`, **mở băng ngay** toàn bộ credit, chu kỳ tiếp tục bình thường.

