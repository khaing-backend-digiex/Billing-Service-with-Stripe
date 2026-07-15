# Business Flow Review — Payment Method · Upgrade/Downgrade · Credit · Cross-flow

**Ngày:** 2026-07-14
**Phạm vi:** review theo LUỒNG nghiệp vụ, sau khi đã cherry-pick `1c61227` (credit idempotency) và `877e0d0` (upgrade/preview).
**Không bàn:** style, naming.

---

## Tóm tắt điều hành

Kiến trúc nền tốt: command/query tách bạch (API ra lệnh cho Stripe, webhook ghi DB), `InvoiceService` sở hữu `Invoice`, CAS khi claim invoice, khoá idempotency mang ngữ nghĩa. Nhưng việc gộp nhánh upgrade vào đã tạo ra **một mô hình domain có ba đường "hạ về free" khác nhau với ba ngữ nghĩa credit khác nhau**, và **upgrade theo tier không cấp credit**.

Ba vấn đề đáng dừng lại trước khi lên `dev`:

1. **Thanh toán thất bại không còn revoke credit** (X1) — regression do merge: người không trả tiền vẫn giữ đủ quyền lợi.
2. **Upgrade tier không cấp credit** (S2) — khách trả tiền lên gói cao, không nhận được gì tới kỳ sau.
3. **Mất vĩnh viễn `invoice.paid`** (C2 + X4) — replay đồng thời ném lỗi, event `FAILED` không có đường quay lại: khách đã trả tiền, credit không bao giờ tới.

**Luật nghiệp vụ đã chốt (2026-07-14):** user gói **FREE không được mua addon**. Việc chặn mua đã có sẵn và đúng (`stripe.controller.ts:148-155`) — đây **không** phải lỗ hổng. Phần còn lại cần chốt là số phận của credit addon **đã mua** khi user rời gói trả phí (xem C1).

---

## 1. Payment Method

Mô hình đúng: API chỉ ra lệnh cho Stripe, webhook (`payment_method.*`, `setup_intent.*`) mới ghi DB. Nếu Stripe OK mà DB hỏng thì webhook sau chữa lại được. `backfillFromStripe` là lưới an toàn tốt. `isExpired` xử lý đúng ranh giới tháng (`new Date(expYear, expMonth, 1)` cho ngày đầu tháng SAU tháng hết hạn — thẻ 12/2026 hết hạn từ 01/01/2027). Không có bug ở đó.

### P1 — `syncDefault` là read-then-write không khoá → local default lệch khỏi Stripe · **High**

**Nguyên nhân.** `payment-method-sync.service.ts:92-110`: đọc `getDefaultPaymentMethodId(customerId)` từ **Stripe** (ngoài transaction), rồi mới mở `$transaction` xoá hết `isDefault` và set lại một thẻ. Hai luồng chạy song song — ví dụ user bấm "đặt thẻ B làm mặc định" trong khi webhook `payment_method.attached` của thẻ C vừa về — cả hai đều gọi `syncDefault`, đọc Stripe ở hai thời điểm khác nhau, rồi ghi đè lẫn nhau.

**Hậu quả.** DB có thể trỏ default sang thẻ mà Stripe **không** coi là default. Lúc mua hàng, `getDefaultOrThrow` trả thẻ local đó và `createOffSessionSubscription` truyền thẳng `default_payment_method: <thẻ local>` → **thu tiền vào thẻ user không chọn**. Cũng có thể kết thúc ở trạng thái 0 thẻ default.

**Hướng sửa.** Khoá theo user (`SELECT ... FOR UPDATE` trên `User`) rồi đọc Stripe **bên trong** transaction; hoặc tốt hơn: đừng poll Stripe — lấy default từ chính event `customer.updated` (xem P2), khi đó payload đã mang giá trị đúng và đơn điệu theo thời gian.

### P2 — Không có strategy cho `customer.updated` → đổi thẻ mặc định qua Billing Portal không bao giờ đồng bộ · **High**

**Nguyên nhân.** Default payment method nằm trên **Stripe Customer** (`invoice_settings.default_payment_method`), không nằm trên PaymentMethod. Đổi nó → Stripe bắn `customer.updated`. `webhook-strategy.factory` không có handler nào cho event này.

**Hậu quả.** User đổi thẻ mặc định trong Billing Portal → Stripe đổi, DB **không** đổi. Và không có đường tự chữa: `list()` gọi `getDefaultForUser`, hàm này thấy đã có `isDefault` local thì **trả luôn**, không đọc lại Stripe (`payment-method-sync.service.ts:141-144`). Lệch vĩnh viễn cho tới khi user tự bấm setDefault trong app.

**Hướng sửa.** Thêm `CustomerUpdatedStrategy` gọi `syncDefaultByCustomer`. Đây cũng là nền để sửa P1.

### P3 — Xoá thẻ default xong không ai lên thay → user có thẻ nhưng không mua được · **Medium**

**Nguyên nhân.** `syncDetached` xoá row rồi gọi `syncDefault`. Stripe **không tự** đề cử thẻ khác làm default sau khi detach → `getDefaultPaymentMethodId` trả `null` → mọi thẻ local về `isDefault: false`. Trong khi đó `getDefaultForUser` chỉ backfill khi **không còn thẻ nào** (`hasAny > 0` → `return null`, dòng 146-147).

**Hậu quả.** User còn 2 thẻ, xoá thẻ default → không thẻ nào là default → `purchase/subscription` báo *"No default payment method"* dù rõ ràng đang có thẻ. Gói đang chạy cũng mất thẻ thu tiền kỳ sau.

**Hướng sửa.** Trong `syncDetached`, nếu Stripe không còn default mà local vẫn còn thẻ → tự đề cử thẻ mới nhất và `setDefaultPaymentMethod` lên Stripe.

### P4 — `remove()` kiểm tra rồi mới hành động · **Medium**

Guard "thẻ default của gói trả phí đang chạy thì không cho xoá" (`payment-methods.service.ts:79-84`) đọc trạng thái rồi mới `detachPaymentMethod`. Một `setDefault` xen vào giữa hai bước là qua được guard. Hậu quả hẹp (mất thẻ thu tiền kỳ sau, user tự thêm lại được) nên để **Medium** — nhưng nếu muốn chặt thì đưa cả guard + detach vào một khoá theo user.

### P5 — `syncDetached` xoá cứng row PaymentMethod · **Low**

Mất dấu vết thẻ nào đã trả hoá đơn nào. Không vỡ FK (bảng `Payment` không tham chiếu tới). Nên chuyển sang soft-delete (`detachedAt`) để giữ lịch sử.

---

## 2. Subscription Upgrade / Downgrade

Đây là vùng vừa gộp code mới và cũng là vùng rủi ro nhất.

### S1 — Upgrade ghi thẳng DB, bỏ qua webhook → **mất luôn event UPGRADED/DOWNGRADED** · **High**

**Nguyên nhân.** `stripe.service.ts:270-300`: gọi Stripe xong thì `prisma.subscription.update({ pricingOptionId })` **ngay tại chỗ**. Sau đó `customer.subscription.updated` mới về, `syncFromStripe` so `existing.pricingOptionId !== pricingOption.id` để quyết định ghi `SubscriptionEvent` — nhưng giá trị đã bị ghi trước rồi nên **hai vế bằng nhau** → không event nào được tạo.

**Hậu quả.** Không còn audit trail cho việc đổi gói. Mọi báo cáo/đối soát dựa trên `SubscriptionEvent` sẽ không thấy upgrade. Ngoài ra đây là vi phạm nguyên tắc "webhook là nguồn sự thật" mà phần còn lại của hệ thống đang tuân thủ — giờ có hai nơi cùng ghi `pricingOptionId` với luật khác nhau.

**Hướng sửa.** Bỏ lệnh ghi DB trong `upgradeSubscriptionTier`/`Cycle`. Để `syncFromStripe` làm việc của nó. Nếu cần phản hồi tức thì cho client, trả về dữ liệu từ `PaymentSubscription` mà Stripe vừa trả, đừng ghi DB.

### S2 — **Upgrade theo tier KHÔNG cấp credit** · **Critical**

**Nguyên nhân.** `stripe.adapter.ts:485-493` dùng `proration_behavior: 'create_prorations'`. Stripe tạo **line item proration** nhưng **không xuất hoá đơn ngay** — chúng nằm chờ tới kỳ sau. Không có hoá đơn → **không có `invoice.paid`** → `PaidInvoiceSyncService` không chạy → `subscriptionCreditsRemaining` và `nextCreditResetAt` **không đổi**.

**Hậu quả.** User nâng Basic (100 credit) → Pro (1000 credit): local `pricingOptionId` thành Pro ngay, nhưng credit vẫn là phần dư của Basic cho tới lần reset sau. **Khách đã đổi gói mà không nhận được gì.** Trong khi đó `upgradeSubscriptionCycle` lại dùng `always_invoice` → có hoá đơn ngay → có credit ngay. **Hai đường upgrade có ngữ nghĩa credit trái ngược nhau.**

Tệ hơn: tới kỳ reset kế tiếp, `CreditResetCronService` đọc `pricingOption.plan.renewalCredits` — giờ là Pro — và cấp **1000 credit** dù hoá đơn proration **chưa được thanh toán**. Tức là **cấp credit trước khi thu tiền**.

**Hướng sửa.** Quyết định dứt khoát ngữ nghĩa upgrade tier:
- Nếu upgrade phải có hiệu lực ngay → dùng `proration_behavior: 'always_invoice'` như đường cycle, để `invoice.paid` cấp credit theo đúng đường đã có. Đây là lựa chọn nhất quán nhất với hệ thống hiện tại.
- Nếu upgrade chỉ có hiệu lực từ kỳ sau → đừng đổi `pricingOptionId` ngay, lưu `pendingPricingOptionId` và chỉ áp dụng khi `invoice.paid` của kỳ mới về.

Không được để nguyên trạng thái hiện tại: nó vừa không giao credit lúc khách cần, vừa giao credit lúc chưa thu được tiền.

### S3 — Upgrade cycle **đốt sạch credit còn lại** của khách · **High**

**Nguyên nhân.** `upgradeSubscriptionCycle` đặt `billing_cycle_anchor: 'now'` → Stripe chốt kỳ mới ngay → `invoice.paid` → `PaidInvoiceSyncService.applyPaidInvoice` → `resetSubscriptionAllowance`, mà hàm này là **revoke phần dư rồi cấp mới**.

**Hậu quả.** Khách đang có 800/1000 credit của tháng, nâng monthly → yearly giữa tháng → **mất 800 credit đó**, chỉ nhận `renewalCredits` mới. Không ai báo trước, preview cũng không nói.

**Hướng sửa.** Đây là quyết định business, không phải bug — nhưng phải **chọn có ý thức**:
- Giữ nguyên (đốt) → phải hiện cảnh báo trong response của preview.
- Hoặc cộng dồn: khi chuyển kỳ do upgrade, cấp thêm phần chênh thay vì reset. Cần một `CreditTransactionType` riêng cho "upgrade top-up", tách khỏi `RENEWAL`.

### S4 — Endpoint tên `upgrade` nhưng không chặn downgrade, và không có "downgrade cuối kỳ" · **High**

**Nguyên nhân.** `payments.controller.ts` chỉ có `upgrade-tier` / `upgrade-cycle`. Không có chỗ nào so giá gói mới với gói cũ. Truyền một `pricingOptionId` rẻ hơn → Stripe áp `create_prorations` → sinh proration **âm** (credit note) → hạ gói **có hiệu lực ngay**.

**Hậu quả.** Hạ gói xảy ra ngay lập tức, khách mất quyền lợi giữa kỳ dù đã trả tiền cho cả kỳ, và **credit không bị revoke** (xem S2 — không có `invoice.paid`), nên khách xuống gói Free mà vẫn giữ credit gói Pro. Quy tắc chuẩn của ngành là **downgrade có hiệu lực cuối kỳ**.

**Hướng sửa.** Tách rõ hai use case. Upgrade → hiệu lực ngay + `always_invoice`. Downgrade → lên lịch cuối kỳ (`proration_behavior: 'none'` + `subscription_schedule`, hoặc lưu `pendingPricingOptionId` và áp khi `invoice.paid` kỳ sau về). Chặn ở API nếu gói mới rẻ hơn mà endpoint là `upgrade`.

### S5 — Upgrade là read-then-act, không khoá, không idempotency key với Stripe · **High**

**Nguyên nhân.** `upgradeSubscriptionTier` đọc `subscription.findUnique({ userId })` → gọi Stripe → ghi DB. Không khoá hàng, không truyền `idempotencyKey` cho `subscriptions.update`.

**Hậu quả.** Hai request upgrade đồng thời (double-click) → cả hai đọc cùng trạng thái → cả hai gọi Stripe → **hai lần proration**, khách bị tính tiền hai lần cho cùng một lần đổi gói. Retry sau timeout mạng cũng cho kết quả y hệt.

**Hướng sửa.** Truyền `{ idempotencyKey }` (dẫn xuất từ `userId + pricingOptionId + cửa sổ thời gian`) làm tham số thứ hai cho SDK Stripe. Khoá hàng subscription theo user trước khi gọi Stripe.

### S6 — Preview không ràng buộc với lần execute · **Medium**

`previewUpgrade*` gọi `invoices.retrieveUpcoming` và trả **nguyên object Stripe** (`Promise<any>`) ra ngoài API. Hai vấn đề: (a) rò rỉ toàn bộ shape của Stripe ra client, khoá chặt hợp đồng API vào Stripe; (b) không có "quote token" — giá có thể đổi giữa lúc preview và lúc execute, khách thấy một số rồi bị trừ số khác.

**Hướng sửa.** Map về một DTO riêng (`amountDue`, `prorationCredit`, `nextInvoiceAt`, `currency`). Nếu cần chắc chắn, lưu preview kèm hash của (subId, priceId, thời điểm) và yêu cầu client gửi lại khi execute.

### S7 — Thiếu "resume subscription" · **Medium**

Có `cancel-subscription` (`cancelSubscriptionAtPeriodEnd`) nhưng không có đường huỷ-việc-huỷ. Khách lỡ bấm huỷ chỉ còn cách vào Billing Portal. `autoRenew` chỉ được `syncFromStripe` ghi, không có API nào set lại.

### S8 — C1 cũ vẫn còn nguyên · **Critical (carry-over)**

`subscription-sync.service.ts:131-137` vẫn suy ra lệnh huỷ trên Stripe từ "con trỏ local lệch". Chưa gỡ. Chi tiết trong `code-review-feat-payment-method.md`.

Đáng chú ý: sau khi có upgrade **update-in-place**, `subscription.id` **không đổi** khi đổi gói → đường upgrade mới **không** kích hoạt C1. Chỉ còn đường `purchase/subscription` (free → paid, tạo sub Stripe MỚI) là còn dính. Điều này gợi ra hướng sửa gốc ở S9.

### S9 — Hai cơ chế "đổi gói" song song · **High (kiến trúc)**

Hệ thống hiện có **hai** cách đổi gói:
- **free → paid**: `purchase/subscription` → `subscriptions.create` → sinh sub Stripe **mới** → phải huỷ sub cũ → chính là nguồn gốc của C1.
- **paid → paid**: `upgrade-tier`/`upgrade-cycle` → `subscriptions.update` → **giữ nguyên** sub id.

**Hậu quả.** Hai đường có ngữ nghĩa proration, credit, và vòng đời Stripe hoàn toàn khác nhau; mọi webhook phải xử lý cả hai. Và đường thứ nhất là thứ đẻ ra quả mìn C1.

**Hướng sửa (quan trọng nhất về mặt kiến trúc).** Thống nhất về `subscriptions.update` cho **mọi** lần đổi gói, kể cả free → paid — user luôn có đúng một Stripe subscription từ lúc onboarding, đổi gói = đổi price của item. Làm được việc này thì:
- C1 **biến mất theo cấu trúc** (không còn repoint, không còn "huỷ cái nó vừa trỏ tới").
- `FreePlanDowngradeService` và `ensureFreeSubscription` không còn lý do tồn tại.
- Proration và credit chỉ còn một luật.

Lưu ý: hướng này **mâu thuẫn** với kế hoạch multi-subscription mà team đang làm. Phải chốt hướng trước khi viết thêm code.

---

## 3. Credit System

Thứ tự tiêu: `SUBSCRIPTION` trước, `ADDON_PURCHASE` sau (`credit.service.ts:72-83`). Đúng — đốt loại sắp hết hạn trước, giữ loại đã mua đứt. Sau `1c61227` + các sửa lỗi, `consume` đã idempotent ở tầng request và `revoke` đã khoá hàng bằng `FOR UPDATE`.

### C1 — Credit addon **đã trả tiền** bị đóng băng khi user rời gói trả phí · **High**

> **Luật nghiệp vụ đã chốt:** user gói FREE **không được mua** addon. Việc chặn mua **đã có** và **đúng** — `stripe.controller.ts:148-155` throw `BadRequestException` nếu không có gói trả phí `ACTIVE`. Phần dưới đây là vấn đề còn lại **sau** khi đã mua hợp lệ.

**Nguyên nhân.** `consume` chỉ đưa bucket addon vào danh sách nguồn khi `balances.isActive` (`credit.service.ts:78`). Cờ `is_active` của ví bị **tắt** ở ba nơi khi user rời gói trả phí:
- `PaidInvoiceSyncService` set `is_active = plan.code !== FREE` (`paid-invoice-sync.service.ts:201-204`) — hạ về Free là tắt.
- `CustomerSubscriptionDeletedStrategy` — `creditWallet.updateMany({ is_active: false })`.
- `handlePaymentFailureExpiration` — tương tự.

**Hậu quả.** User mua 5.000 credit addon lúc đang ở gói Pro (hợp lệ, đã trừ tiền). Sau đó huỷ gói hoặc hạ về Free → ví bị tắt → **số credit đã mua đứt đó không tiêu được nữa**. Không hoàn tiền, không hết hạn, chỉ đơn giản là đóng băng vô thời hạn. Đây là **hàng trả trước** (prepaid), khác về bản chất với quyền lợi kèm gói.

Thêm một điểm bất nhất: đường hạ gói do **nợ tiền** (`downgradeToFreeIfRetriesExhausted`, xem X1) **không** tắt ví — nên người quỵt tiền vẫn tiêu được addon, còn người chủ động huỷ gói thì bị khoá. Ngược hoàn toàn với trực giác.

**Hướng sửa.** Đây là quyết định business, cần chốt rõ ràng — hai lựa chọn, không có đường giữa:
- **Addon là quyền lợi kèm gói trả phí** (giữ nguyên hành vi hiện tại): thì phải nói rõ trong điều khoản khi mua, và ít nhất phải **nhất quán** — đường hạ gói do nợ cũng phải tắt ví.
- **Addon là hàng mua đứt** (khuyến nghị): credit đã trả tiền thì tiêu được bất kể gói hiện tại. Bỏ điều kiện `isActive` khỏi `consume`, và không tắt ví khi hạ gói. Cờ `is_active` khi đó chỉ còn dùng để chặn **mua thêm**, đúng như tên gọi của luật nghiệp vụ đã chốt.

### C1b — Chỉ `ACTIVE` mới được mua addon; `TRIALING` và `PAST_DUE` bị chặn oan · **Low**

`stripe.controller.ts:150` kiểm `status === SubscriptionStatus.ACTIVE`. User đang dùng thử (`TRIALING`) hoặc đang trong cửa sổ retry thanh toán (`PAST_DUE`) đều là user gói trả phí, nhưng không mua được addon. So sánh: `payment-methods.service.ts:11-15` dùng `LIVE_STATUSES = [ACTIVE, TRIALING, PAST_DUE]` cho cùng khái niệm "gói còn hiệu lực". Hai nơi định nghĩa "gói trả phí đang chạy" khác nhau. Nên dùng chung `LIVE_STATUSES`.

### C2 — P2002 giờ **ném lỗi** thay vì no-op → replay đồng thời làm mất credit · **Critical**

**Nguyên nhân.** `1c61227` thay try/catch P2002 bằng check-before-insert (`credit.repository.ts:39-46`) và **bỏ hẳn** phần bắt lỗi. Check-before-insert đóng được lỗi "P2002 làm hỏng cả transaction Postgres" (C3 cũ), nhưng unique constraint vẫn là chốt chặn cuối — và giờ **không ai bắt nó**. Dưới READ COMMITTED, hai delivery đồng thời của cùng một event đều thấy `findUnique` rỗng, đều insert; cái thứ hai ăn P2002 → **throw**.

**Hậu quả.** Kết hợp với X4 (event FAILED là vĩnh viễn): một lần giao trùng `invoice.paid` → exception → event `FAILED` → trả 200 → Stripe **không gửi lại** → **khách đã trả tiền, credit không bao giờ được cấp**. Không ai phát hiện ngoài log.

**Hướng sửa.** Bắt P2002 ở **ngoài** `$transaction` và coi là no-op thành công (transaction đã rollback sạch, không còn nguy cơ 25P02); hoặc bọc riêng lệnh insert trong `SAVEPOINT` để P2002 không giết transaction ngoài. Kèm test replay-đồng-thời chạy trên Postgres thật.

### C3 — Replay `consume` không kiểm `amount` · **Medium**

`credit.service.ts:53-69`: gặp khoá cũ thì dựng lại kết quả từ sổ và trả về, **không so** `cmd.amount` với số đã trừ lần đầu. Client dùng lại `idempotencyKey` với số tiền khác sẽ nhận kết quả cũ, im lặng. Đúng chuẩn idempotency, nhưng nên log cảnh báo hoặc trả 409 để lộ bug phía client.

### C4 — `resetIntervalDay` chỉ hỗ trợ bội số của 30 ngày · **Medium**

`Math.max(1, Math.round(plan.resetIntervalDay / 30))` xuất hiện ở **ba** nơi (`paid-invoice-sync.service.ts:84`, `credit-reset.cron.ts:54`, `free-plan-downgrade.service.ts:79`). Gói 7 ngày → thành 1 tháng. Hợp đồng của field nói "ngày", cài đặt chỉ làm được "tháng".

**Hướng sửa.** Validate `resetIntervalDay % 30 === 0` lúc tạo plan, hoặc cài reset theo ngày thật. Và gom công thức về một helper (xem X6).

### C5 — Addon credit không bao giờ hết hạn; `EXPIRATION` bị dùng cho cả "revoke" · **Low**

Không có TTL cho addon. Về domain model, `CreditTransactionType.EXPIRATION` đang gánh hai sự kiện nghiệp vụ khác nhau: "hết hạn theo kỳ" (reset) và "bị tước do huỷ gói" (revoke). Khi cần báo cáo hoặc hoàn tiền, hai cái này phải phân biệt được.

### C6 — Reconciliation chỉ **phát hiện**, không **sửa**, và không ai bị đánh thức · **High**

`credit-reconciliation.cron.ts:49-74` phát hiện balance âm và lệch `SUM(amount) ≠ balance` rồi… `logger.error('[ALARM]')`. Không metric, không alert, không self-heal. Nghĩa là hệ thống **biết** dữ liệu tiền đang sai mà không ai được báo.

Ngoài ra nó quét **mọi** user với 4 query mỗi user, không batch — 100k user = ~400k query tuần tự lúc nửa đêm.

**Hướng sửa.** Đẩy metric ra hệ thống cảnh báo thật. Gộp thành một query `groupBy` duy nhất. Cân nhắc tự chữa balance từ sổ (sổ là nguồn sự thật) thay vì chỉ báo động.

### C7 — Hai cron cùng chạy lúc 00:00 → reconciliation báo động giả · **Medium**

`CreditResetCronService` và `CreditReconciliationCron` đều `@Cron(EVERY_DAY_AT_MIDNIGHT)`. Reconciliation đọc balance **trong lúc** reset đang sửa balance → thấy `SUM(amount) ≠ balance` do đọc giữa chừng → **[ALARM] giả**. Alarm giả lặp lại mỗi đêm sẽ khiến người ta bỏ qua alarm thật.

**Hướng sửa.** Đẩy reconciliation sang giờ khác (ví dụ 03:00).

---

## 4. Cross-flow consistency

### X1 — **Thanh toán thất bại không còn revoke credit** — regression do merge · **Critical**

Đây là phát hiện quan trọng nhất.

**Trước khi merge**, hết retry → `cancelSubscriptionNow()` → Stripe bắn `customer.subscription.deleted` → `CustomerSubscriptionDeletedStrategy` → **revoke credit + tắt ví + downgrade về free**.

**Sau khi merge** (`877e0d0`), `invoice.payment_failed` → `downgradeToFreeIfRetriesExhausted` → gọi `stripeService.upgradeSubscriptionTier(userId, freeOptionId)` → **đổi giá tại chỗ**, `subscription.id` **không đổi** → **`customer.subscription.deleted` KHÔNG BAO GIỜ BẮN** → không ai revoke credit, không ai tắt ví. Và hàm còn set `status: ACTIVE`.

**Hậu quả.** Khách **không trả tiền**, hết 3 lần retry → bị hạ về gói Free nhưng **giữ nguyên toàn bộ credit của gói trả phí**, ví addon vẫn `is_active`, subscription hiện `ACTIVE`. Tức là **quỵt tiền vẫn dùng được đầy đủ quyền lợi**. Đường revoke duy nhất còn lại là `handlePaymentFailureExpiration` (khi Stripe chuyển sub sang `unpaid`/`canceled`) — nhưng nó chỉ chạy nếu Stripe tự huỷ, mà giờ ta đã đổi giá về free trước khi Stripe kịp làm điều đó.

**Hướng sửa.** Đường hạ-gói-do-nợ **phải** revoke credit + tắt ví, giống hai đường kia. Tốt nhất là gom về một `SubscriptionDowngradeService` duy nhất (xem X2).

### X2 — **Ba cài đặt "hạ về gói free" với ba ngữ nghĩa credit khác nhau** · **Critical (domain model)**

| Đường | Cơ chế Stripe | Revoke credit? | Tắt ví addon? | Status cuối |
|---|---|---|---|---|
| `FreePlanDowngradeService.downgradeToFree` | tạo sub free **mới** + repoint | ❌ (dựa vào caller) | ❌ | `ACTIVE` |
| `CustomerSubscriptionDeletedStrategy` | (phản ứng với `deleted`) | ✅ | ✅ | `CANCELLED` → rồi gọi đường trên |
| `invoice.payment_failed` → `downgradeToFreeIfRetriesExhausted` (**mới**) | `subscriptions.update` đổi giá **tại chỗ** | ❌ | ❌ | `ACTIVE` |

Ba đường này không biết đến nhau. Đường thứ ba còn tự query `plan.findUnique({ code: "FREE" })` thẳng từ Prisma, bỏ qua `stripeService.getFreePriceId()` mà hai đường kia dùng — nên trong test nó bắt phải plan `FREE` thật trong DB dev, không phải plan seed.

**Hậu quả.** Không thể trả lời được câu hỏi "hạ gói thì credit ra sao" — câu trả lời phụ thuộc vào **đường nào tình cờ chạy trước**. Đây là lỗi ở tầng domain model, không phải lỗi code.

**Hướng sửa.** Một `SubscriptionDowngradeService` duy nhất, một ngữ nghĩa credit duy nhất, mọi caller (payment failed / cancelled / user chủ động hạ gói) đi qua nó.

### X3 — `invoice.paid` và `upgrade` cùng ghi một tập field với hai bộ luật · **High**

- `PaidInvoiceSyncService`: ghi `pricingOptionId`, `currentPeriodStart/End`, `nextCreditResetAt`, `status = ACTIVE`, **và reset credit**.
- `upgradeSubscriptionTier`: chỉ ghi `pricingOptionId`, ngay lập tức, **không** period, **không** credit.

Với upgrade tier thì **không có hoá đơn** nên hai bên không bao giờ gặp nhau → local nói "gói Pro" nhưng credit vẫn là của Basic (S2). Rồi `credit-reset.cron` đọc `pricingOption.plan.renewalCredits` = Pro và cấp **credit Pro** ở lần reset kế tiếp — **trước khi hoá đơn proration được thanh toán**.

**Hướng sửa.** Chỉ một nơi được phép ghi `pricingOptionId`: đường webhook. (Đây chính là S1.)

### X4 — Event `FAILED` là vĩnh viễn, không có đường quay lại · **High**

`stripe-webhook.service.ts:40-54`: lỗi không phải `DatabaseException`/`ExternalServiceException` → đánh dấu `FAILED` → **trả 200** → Stripe không gửi lại. Không có cron nào quét lại `FAILED` (hay `RECEIVED` kẹt sau khi app crash). Cơ chế reclaim ở `handleDuplicateClaim` chỉ chạy nếu Stripe **tình cờ** gửi lại event đó.

**Hậu quả.** Cộng với C2, một lỗi thoáng qua là đủ để **mất vĩnh viễn một `invoice.paid`** — khách đã bị trừ tiền, credit không bao giờ tới, và cách duy nhất phát hiện là grep log.

**Hướng sửa.** Cron quét lại `FAILED` / `RECEIVED` quá hạn, chạy lại từ `payload` đã lưu (payload đã có sẵn trong bảng). Cảnh báo thật khi số `FAILED` tăng.

### X5 — Reclaim event không phải compare-and-swap · **Medium**

`handleDuplicateClaim` (`stripe-webhook.service.ts:100-122`) đọc row rồi `update` vô điều kiện. Hai delivery đồng thời của một event `FAILED` → cả hai cùng reclaim → cùng chạy strategy. Các khoá nghiệp vụ đỡ được đường tiền, nhưng `SubscriptionEvent` (không có unique) sẽ nhân đôi.

**Hướng sửa.** `updateMany({ where: { id, status: existing.status } })` và coi `count === 0` là "thua cuộc đua".

### X6 — Logic trùng lặp giữa các service · **Medium**

- `Math.max(1, Math.round(resetIntervalDay / 30))` — ba nơi (C4).
- Tra plan FREE — `stripeService.getFreePriceId()` **và** query prisma trực tiếp trong `invoice.payment_failed`.
- Chọn dòng hoá đơn để lấy giá — `paid-invoice-sync.service.ts:54-56` và `invoice-paid.strategy.ts:30-34` có **hai** thuật toán khác nhau (bản trong strategy có lọc `!isProration`, bản trong sync thì không).
- `LIVE_STATUSES` định nghĩa lại ở `subscription-sync.service.ts` và `payment-methods.service.ts`.

Điểm thứ ba đáng lo nhất: hoá đơn proration (sinh ra từ chính upgrade) là **nhiều dòng**, và hai nơi chọn dòng khác nhau → có thể lấy giá từ dòng này nhưng kỳ từ dòng khác. Xem tiếp X7.

### X7 — Kỳ hoá đơn lấy từ `lines[0]`, giá lấy từ dòng khác · **High** (M1 cũ, nay đã thành lỗi sống)

`stripe.adapter.ts` `mapInvoice` gán `periodStart/periodEnd` từ `lines.data[0]`, trong khi cả `InvoicePaidStrategy` lẫn `PaidInvoiceSyncService` đều chọn `lineToUse` bằng logic riêng (ưu tiên dòng subscription, không proration). Thứ tự dòng của Stripe **không được đảm bảo**.

Trước đây lỗi này ngủ yên vì chưa có luồng nào sinh hoá đơn nhiều dòng. **Upgrade vừa tạo ra chính xác luồng đó.** Hậu quả: sai `currentPeriodStart/End`, sai `nextCreditResetAt`, và sai `creditKey.subscriptionPeriod` — tức là **khoá chống trùng của credit không còn khớp kỳ thật**, mở đường cho cấp credit trùng.

**Hướng sửa.** Lấy period từ **đúng dòng đã lấy giá**; fallback về `period_start/period_end` ở cấp invoice; guard khi `period` không có (hiện tại `new Date(undefined * 1000).toISOString()` sẽ **ném lỗi** ngay trong lúc dựng khoá).

### X8 — `PAST_DUE` không revoke credit · **Medium** (cần xác nhận business)

Thanh toán fail → `status = PAST_DUE`, nhưng credit **vẫn tiêu được** trong suốt 3 lần retry / cửa sổ 3 ngày. Chỉ tới `EXPIRED` (qua `handlePaymentFailureExpiration`) mới revoke. Đây có thể là chủ ý (ân hạn), nhưng cần nói rõ — hiện tại nó là hệ quả tình cờ của việc `PAST_DUE` chỉ đổi status.

### X9 — `providerCustomerId` / `providerSubscriptionId` chưa unique, chưa index · **High** (H3 cũ)

Mọi webhook đều `findFirst` theo hai cột này (`invoice-paid.strategy.ts:49`, `customer.subscription.*`, `payment-method-sync.service.ts:22`). Không unique → không gì ngăn hai user cùng `providerCustomerId` → webhook định tuyến tiền và credit về **row nào `findFirst` trả ra trước**. Không index → quét tuần tự bảng `User`/`Subscription` ở **mọi** webhook.

Với hướng multi-subscription, `providerSubscriptionId` sẽ trở thành **khoá tra cứu chính** → từ "nên có" lên "bắt buộc".

### X10 — Reconciliation không thể sửa được lệch do X1/S2 gây ra · **Medium**

Cron chỉ so `SUM(CreditTransaction.amount)` với balance. Nhưng các lỗi trên (không revoke, không cấp) **không** làm lệch bất biến đó — sổ và balance vẫn khớp nhau, chỉ là **cả hai đều sai so với ý định nghiệp vụ**. Nghĩa là lưới an toàn hiện tại **không bắt được** ba lỗi Critical ở trên.

**Hướng sửa.** Bổ sung một đối soát ở tầng nghiệp vụ: với mỗi subscription `ACTIVE`, `subscriptionCreditsRemaining` phải `<= plan.renewalCredits`; user gói FREE không được có `subscriptionCreditsRemaining > freePlan.renewalCredits`; ví `is_active` phải khớp với gói hiện tại.

---

## Thứ tự đề xuất xử lý

**Chặn merge lên `dev`:**
1. **X1** — hạ gói do nợ phải revoke credit (regression, đang cho không quyền lợi cho người không trả tiền).
2. **S2** — upgrade tier không cấp credit (thu tiền, không giao hàng).
3. **C2** — P2002 ném lỗi + **X4** event FAILED vĩnh viễn (mất `invoice.paid` = mất credit đã trả tiền).

**Ngay sau đó:**
5. **X2** — gom ba đường downgrade về một.
6. **S1 / X3** — chỉ webhook được ghi `pricingOptionId`.
7. **X7** — period phải lấy từ đúng dòng đã lấy giá (upgrade đã kích hoạt lỗi này).
8. **X9** — unique + index.
9. **S8 (C1 cũ)** — gỡ mìn cancel-nhầm-sub.

**Quyết định kiến trúc cần chốt trước khi viết thêm code:**
- **S9** — thống nhất đổi gói qua `subscriptions.update` cho mọi trường hợp (kể cả free → paid)? Nếu có, lỗi cancel-nhầm-sub (S8) và `FreePlanDowngradeService` biến mất theo cấu trúc. Nhưng hướng này **xung đột** với kế hoạch multi-subscription. Phải chọn một.
- **S3** — upgrade giữa kỳ thì đốt hay cộng dồn credit còn lại?
- **C1** — credit addon **đã trả tiền** có tiếp tục tiêu được sau khi user rời gói trả phí không? (Việc **chặn mua** ở gói Free đã chốt là **có** — câu hỏi còn lại chỉ là số phận của credit đã mua.)

---

## Những chỗ làm tốt (giữ nguyên)

- Command/query tách bạch ở payment method: API ra lệnh Stripe, webhook ghi DB → hỏng DB vẫn tự chữa được.
- `claimAsPaid` là CAS trả về boolean mà caller không thể lờ đi.
- Bất biến "không bao giờ hạ một `Payment` đã `SUCCEEDED` xuống `FAILED`" trong `PaymentService`.
- Khoá idempotency mang ngữ nghĩa (neo vào kỳ/mốc reset, không neo vào timestamp lúc chạy).
- `isStale` trong `PaidInvoiceSyncService` — đúng kỷ luật, chỉ tiếc là `SubscriptionSyncService` không có.
- CAS trên `nextCreditResetAt` trong `credit-reset.cron`, cùng với guard "reset vượt quá `currentPeriodEnd` thì nhường cho `invoice.paid`" — chống double-reset ở ranh giới kỳ rất gọn.
- `backfillFromStripe` — lưới an toàn cho thẻ đã lưu từ trước feature này.
