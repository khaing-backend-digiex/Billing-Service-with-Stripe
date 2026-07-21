# Billing Refactor: Single-Subscription → Multi-Subscription

> **Trạng thái**: Thiết kế đã chốt toàn bộ (D1–D12, xem §16). Thứ tự build ở §12 (dev, data mẫu, không migration).
> **Ngày**: 2026-07-15 — **sửa D2 ngày 2026-07-17** (row Free có Stripe subscription, xem §8/§14.1/§16)
> **Phạm vi**: Domain model, entity relationship, Stripe integration, credit lifecycle, implementation path.
>
> **Đã chốt (2026-07-16)** — toàn bộ quyết định D1–D12, chi tiết §16:
> 1. **D1**: Mỗi product = một Stripe Subscription riêng, không gộp items. Thẻ đã lưu (default payment method) tự trừ từng subscription — nhiều invoice/tháng là chấp nhận được (§8).
> 2. **D2 + D3**: Row semantics = Model B (contract instance) **và Free cũng là một subscription row** — mỗi user × product luôn có đúng 1 row live, row cũ chuyển terminal để giữ history tường minh (§8, §14.1). *(Sửa 2026-07-17: row Free **có Stripe subscription thật** trên price giá 0 — `billingMode = PROVIDER`. Lên Pro = hủy sub Free trên Stripe + row Free về terminal. Mọi row đều map 1-1 với một Stripe sub, không còn ngoại lệ.)*
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
| A11 | Idempotency key scope theo user là đủ | `creditKey.consume(userId, requestId)` — **không còn đủ khi consume có chiều product**: key phải thêm productId (`req:{userId}:{productId}:{requestId}:consume`), nếu không hai product dùng chung requestId sẽ dedupe nhầm — request thứ hai không bị trừ credit. Các key `sub:{subscriptionId}` giữ nguyên ngữ nghĩa |

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

Nguyên tắc trung tâm: **Billing trả lời "user đang trả tiền cho cái gì" (Stripe là source of truth); Entitlement trả lời "user được dùng bao nhiêu" (business rule riêng)**. Hai context nối một chiều qua webhook events (chiều **ghi**; riêng gate consume được phép *đọc* trạng thái sub đồng bộ trong cùng transaction — xem cơ chế freeze §9) — chính thức hóa triết lý hiện tại.

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

**Consume** trở thành: lock các grant còn hiệu lực của (user, product) theo thứ tự `priority ASC, expiresAt ASC NULLS LAST, id ASC` — chỉ lock grant có `amountRemaining > 0` (grant cạn không vào lock-set, tránh consume path lock ngày càng nhiều row khi grant tích lũy), drain lần lượt, ghi transaction cho từng grant. Thuật toán `allocateCredits` hiện tại giữ nguyên, chỉ đổi nguồn từ 2 bucket cứng thành n grant. Idempotency key consume **thêm chiều product**: `req:{userId}:{productId}:{requestId}:consume`.

## 5. Product — có, và là gốc của Catalog

Không có Product thì "nhiều subscription" chỉ enforce được bằng convention trên Plan code (`AI_PRO`, `OCR_PRO`) — chính là loại hard-code cần thoát. Product cần tồn tại vì:

1. **Là đơn vị của invariant quan trọng nhất**: "một user chỉ có một subscription live *per product*" — không có Product thì không viết được constraint này ở DB.
2. **Là chiều của credit**: khi AI credits ≠ OCR credits, `CreditGrant.productId` cần FK thật.
3. **Là ranh giới provisioning**: kích hoạt AI khác kích hoạt Storage.

Product nằm ở **đỉnh của Catalog**: `Product → Plan → PricingOption`. Product **không** map sang Stripe (Stripe Product ≈ Plan của mình); nó thuần nội bộ.

Trường: `code` (hiện tại seed đúng 1 row `AI`), `name`, `isActive`. **Chưa thêm** `entitlementType` (`CREDIT` / `QUOTA` / `SEAT`) — phạm vi hiện tại mọi product đều là credit, cột này chỉ đưa vào khi thật sự làm product dạng khác (Storage là quota chứ không phải credit tiêu dần, xem §14). Đã chốt D6: không build trước cho OCR/Storage.

Trade-off: thêm 1 tầng join cho query catalog — chấp nhận được, catalog nhỏ và cache được.

## 6. Plan đại diện cho điều gì?

**Plan = một tier thương mại của một Product** (AI Free, AI Pro, Storage Basic...). Trả lời "user mua *mức* nào", không trả lời "trả bao nhiêu, chu kỳ nào" (việc của PricingOption), không trực tiếp trả lời "được cấp bao nhiêu credit".

Đề xuất tách entitlement policy khỏi Plan (`CreditPolicy` gắn 1-1 với Plan): `creditAmount`, `resetInterval` dạng tường minh (`MONTHLY` / `EVERY_N_DAYS`) thay cho heuristic `resetIntervalDay / 30` (thay A7). Product loại QUOTA thì policy là `quotaAmount` thay vì credit.

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
- Thêm `billingMode: PROVIDER | MANUAL | NONE` — mở đường cho Enterprise (hóa đơn tay) (thay A10). `providerSubscriptionId` bắt buộc khi `PROVIDER`, cấm khi khác.
  **Row Free cũng là `PROVIDER`** (sửa 2026-07-17, xem D2): Free có Stripe subscription thật trên price giá 0, nên nó mang `providerSubscriptionId` như mọi row trả tiền. `NONE` do đó **hiện không có người dùng** — giữ lại trong enum cho row không gắn nguồn billing nào, nếu sau này thật sự cần.

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
3. Đúng webhook-as-source-of-truth: row trả tiền được tạo bởi **`invoice.paid` đầu tiên** (`billing_reason = subscription_create`) — tiền thật mới sinh row; `customer.subscription.deleted` = terminal row. Sub `incomplete` phía Stripe (checkout đang dở / bị 3DS bỏ ngang) **không tạo row local** — tránh đá vào partial unique index khi row Free đang live, và checkout bỏ dở không để lại rác (phương án "row theo tiền thật"; khớp luôn với code hiện tại vốn upsert row trong `invoice-paid.strategy`).
4. **Free là row để history tường minh**: toàn bộ lịch sử gói của user đọc thẳng từ bảng Subscription bằng một query, không phải compose từ `SubscriptionEvent` + khoảng trống giữa các row trả tiền. Lợi ích kèm theo: `nextCreditResetAt` cho free credit vẫn neo trên row → cron reset hiện có phục vụ luôn Free bằng chung một cơ chế với yearly-plan-monthly-reset; sub monthly trả tiền vẫn grant qua `invoice.paid` như hiện tại — vẫn là hai đường grant (webhook + cron), nhưng không phải viết thêm cron grant riêng neo theo User.

**Lifecycle row Free** (quy tắc "luôn đúng 1 live, còn lại inactive"):

- User mới (hoặc lần đầu chạm một product) → tạo **Stripe subscription trên price Free** (giá 0) → row Free `ACTIVE`, `billingMode = PROVIDER`, `providerSubscriptionId` = id của Stripe sub vừa tạo. Row Free vì thế map 1-1 với Stripe y như row trả tiền.
- **Khởi tạo row Free** (spec tường minh — các cột NOT NULL): `currentPeriodStart` / `currentPeriodEnd` lấy từ chính Stripe sub Free (như mọi row `PROVIDER` khác — không tự bịa mốc); `nextCreditResetAt` = `currentPeriodStart` + resetInterval của CreditPolicy plan Free. Cron reset đẩy `nextCreditResetAt` mỗi kỳ; `currentPeriod*` do Stripe đẩy qua webhook. Idempotency của grant free vẫn neo `sub:{id}:reset:{nextCreditResetAt}` như hiện tại.
- Free → Pro: **`invoice.paid` đầu tiên** của Stripe sub Pro (`billing_reason = subscription_create`) là sự kiện tạo row Pro — trong **một DB transaction**: expire row Free (`EXPIRED`) + insert row Pro `ACTIVE` + grant credit (atomicity). **Sau khi transaction commit**, hủy Stripe sub Free (`subscriptions.cancel`): hai Stripe sub không được sống song song trên cùng product. Gọi Stripe *ngoài* transaction vì nó là side-effect không rollback được — transaction fail thì không được lỡ tay hủy sub Free. Checkout bỏ dở (sub `incomplete`/`incomplete_expired`) không đụng DB và không hủy gì — row Free còn nguyên.
- Pro → hủy/hết hạn: row Pro chuyển `CANCELLED` (terminal, từ `customer.subscription.deleted`) + tạo **Stripe sub Free mới** + row Free mới `ACTIVE` — không revive row Free cũ (cũng không revive Stripe sub Free cũ, Stripe không cho un-cancel sub đã hủy), giữ nguyên tắc "row là contract instance, đã terminal thì bất biến".
- **`deleted` của chính sub Free KHÔNG được đẻ row Free mới** — hệ quả trực tiếp của việc Free có Stripe sub: hủy sub Free lúc lên Pro cũng phát `customer.subscription.deleted`. Nếu handler cứ thấy `deleted` là tạo Free mới thì nó sẽ đá vào partial unique index (row Pro đang live), hoặc tệ hơn là đẻ vòng lặp Free → cancel → Free. Quy tắc: **chỉ tạo row Free mới khi (user, product) không còn row live nào khác** — kiểm tra trong cùng transaction với việc terminal row cũ.
- **Webhook tolerance — out-of-order**: Stripe không đảm bảo thứ tự delivery. Mọi handler phải chịu được "row chưa/không tồn tại": `updated`/`deleted` cho sub chưa có row local → ignore + log, không throw (khác `paid-invoice-sync.service.ts:38` hiện tại — trong Model B "row chưa tồn tại" là tình huống thường xuyên, không phải lỗi); `invoice.paid` tự upsert row theo unique `(provider, providerSubscriptionId)` nên không phụ thuộc event `created` đến trước.
- **Race tạo row Free**: webhook `deleted` (có retry) và reconciliation cron đều có thể tạo row Free — partial unique index chặn bản sao; handler phải coi unique-violation là **success** (idempotent), không được fail webhook. Lưu ý race này giờ đắt hơn: mỗi lần thử tạo row Free là một lần tạo **Stripe sub** thật, mà unique-violation xảy ra *sau* khi Stripe đã tạo. Bên thua race phải **hủy lại Stripe sub vừa tạo**, nếu không lại đẻ đúng loại zombie mà quy tắc trên đang chống. Rẻ hơn: kiểm tra row live *trước* khi gọi Stripe, và coi index là lưới cuối.
- Invariant: mỗi user × product có **đúng 1 row live** — partial unique index (§13) áp dụng cho cả Free. `free-plan-reconciliation.cron` giữ lại làm lưới an toàn cho invariant này, generalize theo product.

**Ranh giới quan trọng**: đổi price trong cùng một Stripe subscription (proration — với catalog hiện tại chỉ còn trường hợp đổi chu kỳ PRO monthly ↔ yearly, D10) vẫn là *update trên cùng row*, vì Stripe sub ID không đổi. **Row mới khi và chỉ khi Stripe subscription mới** — áp dụng cho *mọi* row, kể cả Free (từ 2026-07-17 Free cũng có Stripe sub, nên không còn ngoại lệ nào). Sau khi set, `providerSubscriptionId` là immutable. **Tuyên bố bất biến, nói chính xác**: row bất biến theo Stripe sub ID, *không* bất biến theo pricing (`pricingOptionId` đổi khi đổi chu kỳ) — vì vậy **Invoice lưu snapshot `pricingOptionId`** tại thời điểm charge, để "invoice này theo giá nào" trả lời được từ chính Invoice, không phải reconstruct từ SubscriptionEvent.

**Reactivation — đổi ý sau khi hủy gia hạn**: trước khi hết kỳ, un-cancel = set `cancel_at_period_end = false` trên **cùng** Stripe sub → cùng row local, `autoRenew` về true qua webhook `updated` — không row mới, không checkout mới. API mua gói bắt buộc check "đã có sub live cùng product": nếu có → điều hướng sang reactivate (hoặc đổi chu kỳ), **không** tạo Stripe sub thứ hai (sẽ vỡ partial unique index và user bị charge trên sub không hiển thị trong app).

Kịch bản Free → Pro → hủy với thiết kế này: Free ACTIVE → Free EXPIRED + Pro ACTIVE → Pro CANCELLED + Free mới ACTIVE. Tổng cộng **3 row, toàn bộ là lịch sử chuyển gói tường minh**.

Cái giá phải trả (chấp nhận có chủ đích):
- Số row tăng theo số lần chuyển gói × số product.
- **Mỗi user Free = một Stripe subscription thật** (sửa 2026-07-17): số object trên Stripe bằng số user, và mỗi kỳ Free đẻ một invoice $0 → một `invoice.paid` cho mỗi user mỗi tháng. Webhook noise tăng tuyến tính theo user, kể cả user không trả đồng nào. Đây là cái giá chính của D2 bản mới.
- **Mỗi lần chuyển gói là 2 lệnh gọi Stripe** (tạo sub mới + hủy sub cũ), không còn là một. Chúng không nằm chung transaction với DB được, nên luôn tồn tại cửa sổ "đã commit DB mà chưa hủy xong Stripe" → cần reconciliation dọn (xem dưới).
- Giữ `free-plan-reconciliation.cron` (không xóa được như phương án fallback), nhân theo product khi multi-product. Giờ nó gánh thêm việc: **dò Stripe sub Free mồ côi** (row local đã terminal nhưng Stripe sub vẫn `active`) và hủy chúng — đây là lưới an toàn cho cửa sổ ở gạch đầu dòng trên.

Đổi lại: không cần cron grant free credit theo User, không cần lớp compose "free ảo" cho `GET /subscription`, và **mapping "row ⇔ Stripe sub" trở lại tuyệt đối 1-1** — không còn row nào đứng ngoài Stripe, nên `billingMode = NONE` không còn người dùng và `paid-invoice-sync` không cần nhánh riêng cho Free.

## 9. CreditWallet: refactor — thay bằng CreditGrant ledger

Giữ nguyên CreditWallet sẽ chết ở 3 điểm: (1) không có chiều product, (2) không có expiry → không làm được Gift/Promo tử tế, (3) `isAddonUsable` gate theo "plan duy nhất của user" — vô nghĩa khi có nhiều sub (A4).

Thay bằng **CreditGrant** (§4). "Wallet" vẫn tồn tại như **khái niệm đọc** (view/API tổng hợp `SUM(amountRemaining) GROUP BY productId, sourceType`), không còn là bảng ghi.

**Phản biện business rule `isAddonUsable`**: user đã trả tiền mua add-on credits nhưng bị khóa khi rơi về Free — dễ gây khiếu nại, bản chất là dùng add-on làm đòn bẩy giữ subscription. Nếu vẫn giữ, biến nó thành **policy tường minh trên Product** (`addonRequiresLiveSubscription: boolean`) và định nghĩa lại theo product: add-on credits của AI cần sub AI live, không liên quan sub OCR. Khi bị khóa, credit nên **đóng băng** (grant còn đó, không tiêu được) chứ không expire.

**Đã chốt (2026-07-16, D7)**: giữ rule theo đúng hướng này — AI có `addonRequiresLiveSubscription = true`. User rớt về Free AI thì add-on grant **đóng băng**: không tiêu được, không mất, không expire; tự khả dụng lại khi có sub AI trả tiền live.

*(Ghi chú sau review 2026-07-16: phản biện "khóa add-on đã trả tiền dễ gây khiếu nại" giữ nguyên giá trị cảnh báo, nhưng business đã cân nhắc và quyết giữ cả D7 lẫn freeze-all trong PAST_DUE (D9) làm đòn bẩy thu tiền — xem §14.2.)*

**Cơ chế freeze (chốt kỹ thuật)**: freeze là **derive-at-read**, không có cờ `frozen` trên grant. Transaction consume lock các grant **và đọc status của sub live cùng product trong cùng DB transaction** (như `lockForConsume` hiện tại join sang Subscription) — luôn nhất quán, không có race webhook/cache, không có trạng thái freeze "trễ vài giây". Hệ quả phải thừa nhận trung thực: gate consume của Entitlement **đọc đồng bộ** trạng thái Subscription — ranh giới §3 chính xác là "ghi một chiều qua webhook; đọc-để-gate là join trong DB, cấm ghi ngược". Không dùng event-driven flag (cờ frozen cập nhật qua webhook) ở quy mô hiện tại: phải xử lý ordering/replay/reconciliation cho cái cờ đó — không đáng.

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

## 12. Implementation path (build từ đầu trên dev)

> Server dev, **data toàn bộ là mẫu** → không có migration/dual-write/backfill. Mỗi bước đổi schema là `prisma migrate reset` (hoặc `db push`) rồi reseed. Thứ tự dưới đây theo **dependency build**, không phải theo "an toàn với dữ liệu thật".

**Bước 1 — Catalog: thêm Product + tách CreditPolicy** (`prisma/schema.prisma`)
- [ ] Thêm model `Product` (`code`, `name`, `isActive`); seed đúng 1 row `AI` (D6).
- [ ] Thêm `Plan.productId` (FK → Product) + `Plan.isFree: Boolean` (thay so-sánh `PLAN_CODES`, A5); unique `Plan(productId, code)`.
- [ ] Bỏ `Plan.renewalCredits` / `Plan.resetIntervalDay` → model mới `CreditPolicy` 1-1 với Plan: `creditAmount`, `resetInterval` (`MONTHLY` | `EVERY_N_DAYS` + `intervalDays`) — xóa heuristic `resetIntervalDay / 30` (A7).
- [ ] `PricingOption`: thêm unique `(planId, billingCycleId, currency, provider)` + unique `(provider, providerPriceId)`; thêm unique `(id, productId)` để phục vụ FK kép ở Bước 3.
- [ ] Cập nhật `pricing.service.ts` + các DTO `create-plan.dto.ts` / `create-pricing-option.dto.ts` theo shape mới.

**Bước 2 — Entitlement: CreditGrant thay CreditWallet** (`src/credits/*`)
- [ ] Thêm model `CreditGrant` (§4/§4.CreditGrant): `userId`, `productId`, `sourceType`, `sourceRef`, `amountGranted`, `amountRemaining`, `expiresAt?`, `priority`; CHECK `remaining >= 0` và `remaining <= granted`.
- [ ] `CreditTransaction.grantId` (FK → CreditGrant, NOT NULL ở build mới); giữ nguyên unique `idempotencyKey`.
- [ ] Xóa model `CreditWallet` khỏi schema.
- [ ] `credit.repository.ts`: `lockForConsume` đổi từ lock 2 bucket (`subscriptionCreditsRemaining` + `CreditWallet.addonCredits`) sang lock **n grant** của (user, product) `WHERE amountRemaining > 0 ORDER BY priority, expiresAt NULLS LAST, id FOR UPDATE`; join Subscription để đọc status live (freeze derive-at-read, §9).
- [ ] `credit-allocation.ts` (`allocateCredits`): giữ thuật toán, đổi input từ 2 bucket cứng → danh sách grant.
- [ ] `credit.service.ts`: `consume` nhận thêm `productId`; idempotency key `req:{userId}:{productId}:{requestId}:consume` (A11). `adjust` (gift/admin) tạo `CreditGrant(GIFT/ADMIN)` thay `ADJUSTMENT` vô danh (A9).
- [ ] `consume-credits.dto.ts` + `credits.controller.ts`: thêm chiều `productId`.
- [ ] Wallet trở thành **read-only view**: API tổng hợp `SUM(amountRemaining) GROUP BY productId, sourceType`.

**Bước 3 — Subscription + webhook lifecycle (Model B, Free = row)**
- [ ] `schema.prisma` Subscription: bỏ `userId @unique`; thêm `productId` + `billingMode (PROVIDER|MANUAL|NONE)`; bỏ `subscriptionCreditsRemaining`, `trialStart`, `trialEnd`. Partial unique index `(userId, productId) WHERE status IN ('ACTIVE','PAST_DUE')` (§13.1). FK kép `(pricingOptionId, productId) → PricingOption(id, productId)`. CHECK `(billingMode='PROVIDER') = (providerSubscriptionId IS NOT NULL)`.
- [ ] `Invoice`: thêm snapshot `pricingOptionId` tại thời điểm charge (§8, M5).
- [ ] `invoice-paid.strategy.ts` + `paid-invoice-sync.service.ts`: **xóa logic repoint** (`shouldRepoint`/`isStale`); row trả tiền tạo bởi `invoice.paid` đầu tiên (`billing_reason = subscription_create`) trong 1 transaction: expire row Free → insert row Pro `ACTIVE` → grant credit. Upsert theo unique `(provider, providerSubscriptionId)`.
- [ ] `customer.subscription.deleted.ts`: row terminal `CANCELLED` + tạo **row Free mới** trong cùng transaction (không revive row cũ); coi unique-violation là success (idempotent).
- [ ] `customer.subscription.updated.ts`: xử lý reactivation (`cancel_at_period_end=false` → `autoRenew=true`) + cycle change (đổi `pricingOptionId` trên cùng row); **ignore + log** khi row local chưa tồn tại (out-of-order tolerance) thay vì throw như `paid-invoice-sync.service.ts:38` hiện tại.
- [ ] `invoice.payment_failed.ts` / `invoice-payment-action-required.strategy.ts`: mirror `PAST_DUE`, đếm `attempts`; **không** thêm timer nội bộ (dunning là cấu hình Stripe).
- [ ] `payments.service.ts`: API mua gói check "đã có sub live cùng product" → điều hướng reactivate/cycle-change, **không** tạo Stripe sub thứ hai (M6); `upgradeSubscriptionTier` chặn `newPricingOptionId` khác product.
- [ ] `provisioning/user-provisioning.service.ts`: user mới → tạo Stripe sub trên price Free rồi ghi row Free `ACTIVE`, `billingMode=PROVIDER`, `providerSubscriptionId` = sub vừa tạo (spec khởi tạo row Free — §8).
- [ ] `invoice-paid.strategy.ts`: sau khi commit row Pro, **hủy Stripe sub Free** của cùng (user, product). Hiện **chưa có** — đoạn hủy ở `subscription-sync.service.ts:146` đã chết từ `9d84f12` (tìm `existing` theo `providerSubscriptionId: sub.id` rồi hỏi nó khác `sub.id`, vĩnh viễn false), nên sub Free đang bị bỏ rơi trên Stripe.
- [ ] `invoice-paid.strategy.ts`: lookup row phải **lọc status live**. Hiện tìm theo `providerSubscriptionId` không kèm status, nên `invoice.paid` của sub Free zombie (gia hạn $0 mỗi kỳ) **hồi sinh row Free đã EXPIRED về ACTIVE** → hai row live cùng product → vỡ partial unique index §13.1.
- [ ] `customer.subscription.deleted.ts`: chỉ tạo row Free mới khi (user, product) **không còn row live nào khác** — nếu không, `deleted` của chính sub Free lúc lên Pro sẽ đẻ vòng lặp (§8).

**Bước 4 — Cron: generalize theo product** (`src/cron/*`)
- [ ] `credit-reset.cron.ts`: reset theo `CreditPolicy.resetInterval` (bỏ `Math.round(resetIntervalDay/30)`); phục vụ cả row Free lẫn yearly-plan-monthly-reset; grant reset neo `sub:{id}:reset:{nextCreditResetAt}`.
- [ ] `free-plan-reconciliation.cron.ts` + `free-plan-downgrade.service.ts`: **giữ lại**, refactor thành "đảm bảo đúng 1 row live per (user, product)" + generalize theo product; là lưới an toàn cho partial unique index.
- [ ] `credit-reconciliation.cron.ts`: đối chiếu theo grant thay vì cột cũ.

**Bước 5 — Dọn hard-code**
- [ ] Xóa `PLAN_CODES` / `isAddonUsable` (`plan.constants.ts`, `credit.service.ts`) → thay bằng `Plan.isFree` + `Product.addonRequiresLiveSubscription` (§9, D7).
- [ ] Rà mọi chỗ giả định "1 sub / user" (`subscription.update({ where: { userId } })`) → query theo (userId, productId, status live).

**Bước 6 — Seed dữ liệu mẫu**
- [ ] Seed: Product `AI` → Plan `AI Free` (isFree, CreditPolicy monthly) + `AI Pro` → PricingOption (monthly/yearly) + AddonPackage.
- [ ] Seed vài user: 1 Free-only, 1 Pro live, 1 vừa Pro vừa có add-on grant — để test consume/freeze/reset end-to-end.

## 13. Business rule enforce bằng DB constraint

1. **Một sub live per user per product**: `CREATE UNIQUE INDEX ... ON "Subscription"(userId, productId) WHERE status IN ('ACTIVE','PAST_DUE')`. Live-set chỉ còn 2 status: `INCOMPLETE` không bao giờ ghi local (row chỉ tạo khi `invoice.paid` đầu tiên — §8), `TRIALING` không dùng (D12), `PAUSED` loại khỏi live-set và không viết lifecycle cho đến khi có nhu cầu thật (nhất quán D6). Phải denormalize `productId` vào Subscription vì Postgres không index xuyên join; chống lệch denormalize bằng FK kép: unique `(id, productId)` trên PricingOption + FK `Subscription(pricingOptionId, productId) → PricingOption(id, productId)`.
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

**Free là một subscription row.** Phương án fallback ("không có sub live = hưởng free tier") từng được đề xuất để tránh row Free tích lũy khi chuyển gói, nhưng bị bác vì mục tiêu chính của multi-row là **history tường minh**: chuỗi Free → Pro → Free đọc thẳng từ bảng Subscription, không phải suy từ khoảng trống giữa các row trả tiền. Lợi ích kèm theo: `nextCreditResetAt` neo trên row Free → cron reset hiện có phục vụ luôn Free (chung cơ chế với yearly-reset; monthly trả tiền vẫn grant qua webhook), không cần cron grant free credit riêng neo theo User. Chi phí chấp nhận: giữ reconciliation cron.

**Sửa 2026-07-17 — Free có Stripe subscription**: bản đầu của D2 cho row Free đứng ngoài Stripe (`billingMode = NONE`, không `providerSubscriptionId`). Đã đảo: user mới vẫn được tạo **Stripe sub trên price Free** (đúng hành vi `subscribeToFreePlan` đang chạy), rồi khi lên Pro thì **hủy sub Free trên Stripe** và cho row Free về terminal để giữ history. Hệ quả: row Free là `billingMode = PROVIDER`, mapping row ⇔ Stripe sub trở lại 1-1 tuyệt đối, không còn ngoại lệ; đổi lại mỗi user Free tốn một Stripe sub + một invoice $0 mỗi kỳ (§8).

**Phạm vi hiện tại (D6)**: Free plan chỉ tồn tại cho product **AI** — mỗi user có đúng 1 row Free (AI) khi không có sub AI trả tiền. Product tương lai (OCR/Storage) có free tier hay không sẽ quyết định khi làm product đó; không tạo sẵn row Free cho product chưa ra mắt.

### 14.2. Hủy gói và dunning (đã chốt 2026-07-16 — D8, D9)

**Hủy gói — hai đường, ngữ nghĩa khác nhau:**

- **Hủy gia hạn** (mặc định, map `cancel_at_period_end = true` phía Stripe): subscription và credit subscription **sống đến hết `currentPeriodEnd`** — user đã trả tiền cho cả kỳ. Cuối kỳ, webhook `customer.subscription.deleted` → row chuyển `CANCELLED` (terminal), credit subscription còn lại expire, tạo row Free mới, add-on credit đóng băng (D7).
- **Hủy ngay** (cancel immediately): **mất gói tại chỗ** — Stripe sub hủy ngay, row terminal ngay, credit subscription expire ngay, rớt về Free ngay. Không hoàn tiền phần kỳ còn lại (D11: không refund). **Vẫn mở cho user tự thao tác** (xác nhận 2026-07-16 sau review): UI bắt buộc confirm hai bước với cảnh báo tường minh "mất toàn bộ credit còn lại + không hoàn tiền phần kỳ đã trả" — user được quyền chọn, nhưng không thể chọn nhầm.

**Dunning (PAST_DUE) — ân hạn 3 ngày:**

- Invoice gia hạn charge thất bại → sub chuyển `PAST_DUE`; retry **3 lần trong 3 ngày (mỗi ngày 1 lần)** — toàn bộ là **cấu hình dunning phía Stripe** (retry schedule + hành động sau retry cuối = cancel subscription). Local chỉ mirror qua webhook `invoice.payment_failed` (đếm `attempts` trên Invoice như hiện tại). **Không có timer nội bộ** cho `billingMode = PROVIDER` — một nguồn authority duy nhất, đúng webhook-as-source-of-truth; cron hết hạn nội bộ chỉ dùng cho `MANUAL`/`NONE`.
- Trong ân hạn: **đóng băng toàn bộ credit** — cả credit subscription lẫn add-on đều không tiêu được (grant còn nguyên, không mất, không expire). Consume của product đó chỉ được phép khi sub live ở trạng thái `ACTIVE`. *Lưu ý: đây là thay đổi so với hành vi hiện tại — code hiện nay vẫn cho tiêu subscription credit khi `PAST_DUE`.* **Đóng băng cả add-on là quyết định thương mại có chủ đích** (xác nhận lại 2026-07-16 sau review): dùng freeze làm đòn bẩy thu tiền, chấp nhận rủi ro khiếu nại từ khách đã mua add-on đứt (phản biện ở §9 đã được cân nhắc và bác).
- Hết retry → **Stripe cancel subscription** → webhook `customer.subscription.deleted` là sự kiện **duy nhất** chuyển row sang terminal (`CANCELLED`) + tạo row Free mới; credit subscription còn lại expire, add-on theo D7. Local không bao giờ terminal row trước Stripe — nếu retry muộn thành công (thẻ được mở khóa trước khi Stripe cancel), `invoice.paid` đến → về `ACTIVE`, **mở băng ngay**; không tồn tại nhánh "local đã rớt Free nhưng Stripe vẫn charge tiền".

## 16. Các quyết định — trạng thái

| # | Quyết định | Nội dung đã chốt | Trạng thái |
|---|-----------|---------|-----------|
| D1 | Stripe: một Stripe Subscription per product, hay gộp items? | Một Stripe Subscription riêng per product; thẻ lưu sẵn tự trừ từng sub nên không cần gộp hóa đơn (§8) | **Đã chốt 2026-07-16** |
| D2 | Free tier: row hay fallback? | **Row** — Free là subscription row; luôn 1 row live, row cũ terminal giữ history (§8, §14.1). **Sửa 2026-07-17**: row Free **có Stripe subscription** (price giá 0, `billingMode = PROVIDER`) chứ không đứng ngoài Stripe như bản đầu; lên Pro thì hủy sub Free trên Stripe + row Free về terminal. Mapping row ⇔ Stripe sub 1-1 tuyệt đối; giá phải trả là mỗi user Free tốn 1 Stripe sub + 1 invoice $0 mỗi kỳ | **Đã chốt 2026-07-16, sửa 2026-07-17** |
| D3 | Row semantics: slot (A) hay contract instance (B)? | Model B — row trả tiền mới khi và chỉ khi Stripe subscription mới; row Free mới khi user rơi về free | **Đã chốt 2026-07-16** |
| D4 | Có đưa `BillingAccount` vào không? | Không — không có kế hoạch B2B/team billing | **Đã chốt 2026-07-16** |
| D5 | Credit universal hay per product? | Per product — add-on là SKU riêng của từng product (1000 credit AI, 1000GB Storage...); `CreditGrant.productId` bắt buộc | **Đã chốt 2026-07-16** |
| D6 | Phạm vi product hiện tại | Chỉ AI; Free plan chỉ cho AI; không build trước cho OCR/Storage (`entitlementType`, nhánh Quota... chỉ thêm khi cần) | **Đã chốt 2026-07-16** |
| D7 | Add-on credits khi rớt về Free | Đóng băng — không tiêu được, không mất, không expire; mở lại khi có sub trả tiền live (`addonRequiresLiveSubscription = true` cho AI, §9) | **Đã chốt 2026-07-16** |
| D8 | Hủy giữa kỳ | Hủy gia hạn: sống + tiêu credit đến hết kỳ rồi rớt Free. Hủy ngay: terminal ngay, credit expire ngay, rớt Free ngay — user vẫn được tự hủy ngay nhưng UI phải confirm hai bước cảnh báo mất credit + không refund (§14.2) | **Đã chốt 2026-07-16** |
| D9 | Dunning PAST_DUE | Ân hạn 3 ngày, retry 3 lần (1 lần/ngày) — cấu hình phía Stripe, hành động cuối = Stripe cancel sub, local terminal qua webhook `deleted` (§14.2); **trong ân hạn đóng băng toàn bộ credit** (cả subscription lẫn add-on); trả tiền thành công → mở băng ngay | **Đã chốt 2026-07-16** |
| D10 | Upgrade giữa kỳ | Tách 2 khái niệm: **tier change** không tồn tại (catalog chỉ FREE/PRO; Free → Pro là mua Stripe sub mới); **cycle change** (PRO monthly ↔ yearly) là flow được hỗ trợ — update price trên cùng Stripe sub với proration, không cấp lại credit giữa kỳ, credit cấp ở invoice kỳ sau; Invoice snapshot `pricingOptionId` giữ history đúng (§8) | **Đã chốt 2026-07-16** |
| D11 | Refund | **Không refund** gói/add-on đã mua — khỏi cần flow clawback credit; nếu tương lai business cần thì thiết kế riêng khi đó | **Đã chốt 2026-07-16** |
| D12 | Trial | **Bỏ hoàn toàn** — không trial cho plan nào; không có cột `trialStart`/`trialEnd`, bỏ sourceType `TRIAL`, không dùng Stripe trial (§11) | **Đã chốt 2026-07-16** |

