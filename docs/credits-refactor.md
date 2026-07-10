# Refactor hệ thống Credits — Credit Aggregation Layer

> Trạng thái: đề xuất kiến trúc, chưa thi hành.
> Nguyên tắc chủ đạo: **refactor tối thiểu**, không redesign toàn bộ project.

---

## 1. Bối cảnh

Credit hiện sống ở hai nơi:

- `Subscription.subscriptionCreditsRemaining` — credit theo gói, reset mỗi kỳ, **không cộng dồn**.
- `CreditWallet.addonCredits` — credit mua thêm, **cộng dồn**, không bao giờ hết hạn.

`CreditTransaction` ghi lại mọi thay đổi nhưng **không ai đọc nó để suy ra số dư**.

Thứ tự tiêu mong muốn: Subscription → Add-on → (Bonus, nếu có sau này).

---

## 2. Ba phát hiện từ code hiện tại

Các kết luận dưới đây dựa trên grep toàn bộ `src` và `test`, cùng dữ liệu thật trong DB.

### 2.1 `is_active` là state chỉ-ghi

```
src/stripe/sync/paid-invoice-sync.service.ts:174   ghi
src/stripe/webhook/strategies/payment-intent-succeeded.strategy.ts:88   ghi
```

Không có chỗ nào **đọc**. Cột này không gate bất cứ thứ gì. **Xóa được.**

Hệ quả: lo ngại "downgrade khóa credit add-on mà user đã trả tiền" **không đúng với code hiện tại**.

### 2.2 `addonCredits` cũng chỉ-ghi

Chỉ có `upsert` tăng, không nơi nào trừ hay đọc. Nghĩa là **đường consume chưa tồn tại**.

`CreditService.consume()` không phải refactor — nó là bề mặt mới, được thiết kế đúng ngay từ đầu.

### 2.3 Bảy nơi đang ghi credits

| File | Ghi gì |
|---|---|
| `cron/credit-reset.cron.ts` | gán `subscriptionCreditsRemaining` |
| `stripe/sync/paid-invoice-sync.service.ts` | gán credits, ghi `CreditTransaction`, ghi `is_active` |
| `stripe/sync/subscription-sync.service.ts` | `subscriptionCreditsRemaining: 0` ở nhánh create |
| `stripe/webhook/free-plan-downgrade.service.ts` | đốt + cấp credits |
| `stripe/webhook/strategies/customer.subscription.deleted.ts` | zero credits + `EXPIRATION` |
| `stripe/webhook/strategies/customer.subscription.updated.ts` | zero credits + `EXPIRATION` |
| `stripe/webhook/strategies/payment-intent-succeeded.strategy.ts` | tăng `addonCredits` |

Đây là con số mà choke point phải thu về **một**.

### 2.4 Bug đang sống: cấp credit hai lần khi downgrade

Dữ liệu thật, user 13, ngày 2026-07-09:

```
01:42:57.514  SubscriptionEvent  CANCELLED
01:42:57.566  CreditTransaction  EXPIRATION  -100
01:43:00.479  CreditTransaction  RENEWAL     +50   "Credits granted – Gói free (downgrade)"
01:43:00.531  SubscriptionEvent  DOWNGRADED
01:43:01.416  CreditTransaction  RENEWAL     +50   "Credits granted Gói free (initial)"
01:43:01.517  SubscriptionEvent  CREATED
```

Dòng `+50` đầu do `free-plan-downgrade.service.ts`. Dòng `+50` sau do `invoice.paid` của chính free subscription vừa tạo (Stripe phát hành invoice $0, `billing_reason = subscription_create`).

Tổng sổ: `+100 −100 +50 +50 = +100`. Số dư thật: **50**. Lệch 50.

**Nguyên nhân không phải thiếu ledger.** Nó là ba thứ:

1. Số dư được ghi bằng **phép gán** (`= 100`), còn `CreditTransaction` ghi bằng **delta** (`+100`). Hai thứ này không đối soát được với nhau.
2. **Hai component cùng cấp credit** cho một sự kiện.
3. Không có khóa chống trùng **theo ngữ nghĩa**. Chống theo `eventId` vô dụng — đó là hai event Stripe khác nhau, cả hai đều hợp lệ.

Phép gán tự nó idempotent, nên nó **che giấu** lỗi: số dư luôn trông đúng, không ai khiếu nại.

---

## 3. Nguyên tắc kiến trúc

1. **Không có Wallet lưu số dư tổng.** Số dư sống cạnh thực thể quyết định vòng đời của nó. `totalCredits` là giá trị dẫn xuất, **không bao giờ lưu**.
2. **`CreditService` là writer duy nhất** của mọi cột `remainingCredits`.
3. **Cấm phép gán.** Mọi thay đổi là `increment(delta)` có dấu. "Reset về allowance" biểu diễn thành hai delta: `EXPIRATION −remaining` rồi `RENEWAL +allowance`.
4. **Ghi số dư và ghi `CreditTransaction` trong cùng một DB transaction**, luôn luôn.
5. **Idempotency theo ngữ nghĩa nghiệp vụ**, không theo `eventId`.
6. **`CreditService` không được biết Stripe tồn tại.** Nó nhận mệnh lệnh đã quyết định, không nhận event thô.

### Vì sao delta thay vì gán

Ngoài việc đối soát được, delta còn **an toàn dưới race condition**:

> Consume đọc `remaining = 10`, chưa kịp ghi thì renew reset về 100.
> Với **gán** (`= 0`): mất trắng 100 credit vừa cấp.
> Với **delta** (`increment(-10)`): kết quả 90 — đúng.

Phần thưởng kèm theo: bút toán `EXPIRATION` cho biết mỗi tháng user đốt phí bao nhiêu credit không xài hết. Dữ liệu định giá, miễn phí.

---

## 4. Cấu trúc thư mục

```
src/credits/
  credits.module.ts
  credit.service.ts        # bề mặt công khai — writer duy nhất
  credit.repository.ts     # nơi duy nhất chạm cột remaining + CreditTransaction
  credit-allocation.ts     # thuật toán phân bổ consume (thuần, không DB)
  credit.types.ts          # command types + bucket + kết quả

src/cron/
  credit-reconciliation.cron.ts   # mới: chỉ báo động, không tự sửa
```

Năm file. **Không** command bus, **không** CQRS, **không** event emitter. Command là object có kiểu, truyền bằng lời gọi hàm thường.

`CreditsModule` chỉ import `DatabaseModule`. `StripeModule` và `CronModule` import nó.

---

## 5. Trách nhiệm từng file

### `credit.service.ts`

Nhận **mệnh lệnh nghiệp vụ đã được quyết định**. Sáu method:

`grantSubscriptionAllowance` · `revokeSubscriptionCredits` · `grantAddonCredits` · `consume` · `adjust` · `getBalance`

Lo khóa hàng, thứ tự khóa tất định, kiểm tra không âm, cưỡng chế idempotency key.

**Không** gọi Stripe. **Không** biết `PLAN_CODES.FREE`. **Không** biết `billing_reason`. Nếu nó bắt đầu cần biết, biên giới đã bị dựng sai.

### `credit.repository.ts`

Điểm nghẽn thật sự. **Không** expose `updateBalance()`. Chỉ expose đúng một thao tác ghi:

```
applyDelta(bucket, delta, transactionEntry, tx)
```

Không cách nào thay đổi số dư mà không sinh bút toán, và ngược lại. **Ghi lệch trở thành không biểu diễn được ở tầng kiểu**, chứ không phải một quy ước trong code review.

Cũng là nơi bắt `P2002` trên unique index của idempotency key và biến nó thành no-op im lặng.

### `credit-allocation.ts`

Hàm thuần: nhận danh sách nguồn `(bucket, remaining, expiresAt)` và số lượng cần tiêu, trả về phân bổ.

Tách ra vì đây là chỗ dễ sai nhất và cần unit test không cần DB.

Cũng là nơi phát biểu luật **"tiêu thứ sắp hết hạn trước"** thay vì hardcode `subscription → addon`. Hai luật cho cùng kết quả hôm nay — credit subscription hết hạn ở lần reset kế, credit add-on không bao giờ hết hạn, nên vô cực luôn muộn hơn — nhưng chỉ một cái còn đúng khi bonus có hạn dùng.

### `credit.types.ts`

Command mang sẵn `idempotencyKey`. Người gọi tự tính, vì chỉ người gọi biết ngữ nghĩa nghiệp vụ.

| Lệnh | Khóa |
|---|---|
| grant renewal | `sub:{id}:period:{periodStart}:grant` |
| cron reset trong kỳ | `sub:{id}:reset:{nextCreditResetAt}` |
| revoke | `sub:{id}:revoke:{stripeSubscriptionId}` |
| addon | `pi:{paymentIntentId}` |
| consume | `req:{requestId}` |

> **Cảnh báo:** gói năm reset credit **hàng tháng**. Mốc chống trùng của cron là `nextCreditResetAt`, **không phải** `periodStart`. Dùng nhầm một khóa là mất 11 lần reset.

---

## 6. Luồng gọi và ranh giới transaction

```
StripeWebhookController
  └─ StripeWebhookService        (dedup theo eventId — giữ nguyên)
      └─ Strategy                 (adapter: dịch event → command)
          └─ Billing service      (paid-invoice-sync / free-plan-downgrade / subscription-sync)
              ├─ Prisma           (invoice, payment, subscription — nghiệp vụ của nó)
              └─ CreditService    (command)
                  └─ CreditRepository → applyDelta
```

### Vấn đề khó nhất

`paid-invoice-sync` đang cập nhật subscription **và** credits trong *một* `$transaction`. Tách `CreditService` ra thì atomicity đi đâu?

| Phương án | Đánh giá |
|---|---|
| **(a) `CreditService` nhận `tx?` tùy chọn** | ✅ Chọn. Billing service mở transaction, truyền client xuống. Một transaction, atomic như cũ. |
| (b) `CreditService` tự mở transaction riêng | ❌ Có cửa sổ subscription đã đổi mà credit chưa. Cần outbox. Quá nặng. |
| (c) Application service ở trên mở transaction cho cả hai | ❌ Thêm một tầng chỉ để tránh truyền `tx`. |

Người ta hay chê (a) vì "leak Prisma vào signature". Nhưng bất biến cần giữ là **ai được phép phát lệnh ghi**, không phải **ai sở hữu transaction**. `tx` là ngữ cảnh, không phải quyền.

Cron đơn giản hơn: không mở transaction, chỉ gọi `grantSubscriptionAllowance` và để `CreditService` tự lo.

---

## 7. Đổi trách nhiệm vs giữ nguyên

### Đổi

**`paid-invoice-sync.service.ts`** — giữ invoice upsert, payment upsert, cập nhật chu kỳ/plan. **Bỏ** gán `subscriptionCreditsRemaining`, bỏ `creditTransaction.create`, bỏ `creditWallet.updateMany`. Thay bằng `revokeSubscriptionCredits(reason: period_rollover)` rồi `grantSubscriptionAllowance`.

→ Đây là **chủ sở hữu duy nhất** của việc cấp credit subscription.

**`free-plan-downgrade.service.ts`** — **bỏ toàn bộ ghi credit**. Chỉ tạo free sub trên Stripe, trỏ lại row, ghi `SubscriptionEvent(DOWNGRADED)`. Credit gói Free do `invoice.paid` của chính free sub cấp.

→ Đây chính là bản vá cho bug §2.4.

> **Đánh đổi:** nếu `invoice.paid` đó thất lạc, user ở 0 credit cho tới khi reconciliation cron cấp bù. Chấp nhận được, vì lệnh cấp bù mang cùng khóa idempotency nên an toàn khi chạy lại.

**`customer.subscription.deleted.ts`** và nhánh EXPIRED của **`customer.subscription.updated.ts`** — thay `subscriptionCreditsRemaining: 0` + `creditTransaction.create(-remaining)` bằng `revokeSubscriptionCredits`. Vẫn giữ đổi `status` và ghi `SubscriptionEvent`.

**`payment-intent-succeeded.strategy.ts`** — giữ `payment.upsert`, thay `creditWallet.upsert` + `creditTransaction.create` bằng `grantAddonCredits`.

**`credit-reset.cron.ts`** — trở thành **bộ lập lịch thuần**. Quét subscription tới hạn, phát lệnh. Không còn `$transaction`, không còn ghi DB.

**`subscription-sync.service.ts`** — chỉ bỏ `subscriptionCreditsRemaining: 0` khỏi nhánh `create`. Row mới sinh ra với 0 là mặc định của cột.

### Giữ nguyên hoàn toàn

`stripe.adapter.ts` · `payment.types.ts` · `IPaymentAdapter` · `stripe-webhook.service.ts` (dedup theo `eventId` vẫn cần và **trực giao** với idempotency nghiệp vụ) · `invoice.payment_failed.ts` (không chạm credit) · `webhook-strategy.factory.ts` · toàn bộ `pricing`, `users`, `provisioning`.

---

## 8. Thừa và nên tách

### Xóa được ngay

`CreditWallet.is_active` — cột chết (§2.1).

### Cần thành thật với chính mình

Nếu `remainingCredits` của add-on vẫn là **một con số duy nhất trên mỗi user**, thì bảng `AddonBalance(userId, remaining)` và bảng `CreditWallet(userId, addonCredits)` là **cùng một thứ, khác tên**. Đó không phải bỏ Wallet, đó là đổi nhãn.

"Không có Wallet" chỉ có nghĩa thật khi `remainingCredits` nằm **trên từng bản ghi mua add-on** — mỗi lần mua là một lô, có `remaining` riêng, có thể có `expiresAt` riêng. Lúc đó mới có thứ Wallet không cho được: hoàn tiền đúng đơn hàng, hạn dùng theo lô, consume theo hạn.

Phải chọn dứt khoát:

| Phương án | Chi phí | Được gì |
|---|---|---|
| Giữ `CreditWallet.addonCredits`, chỉ xóa `is_active` | Zero migration | Không có lô. Đừng gọi là "không có Wallet". |
| Chuyển thành hàng cấp phát theo từng lần mua | **Thay đổi schema duy nhất không thể tránh** | Lô, hạn dùng, refund theo đơn. Kéo theo `credit-allocation` phải xử lý nhiều lô → thứ tự khóa tất định và trần fanout. |

Nghiêng về phương án hai **chỉ vì** đã biết trước Gift/Promotion sẽ tới. Nếu chúng không tới, phương án một rẻ hơn nhiều.

### Nên tách thêm — đúng một thứ

**`credit-reconciliation.cron.ts`.** Không phải tính năng, mà là **thiết bị đo**. Ba kiểm tra:

1. `SUM(CreditTransaction theo bucket) == remaining` của từng nguồn — cái bắt được ca §2.4.
2. Không nguồn nào âm; `subscriptionRemaining <= renewalCredits`.
3. Mỗi subscription `ACTIVE` có `nextCreditResetAt` đã qua thì phải tồn tại bút toán cấp cho mốc đó.

> **Đừng cho nó tự sửa.** Khi số dư và sổ mâu thuẫn, bạn *không biết* bên nào đúng — nếu bug là "gán thay vì delta" thì số dư đúng, sổ sai; nếu bug là "quên ghi" thì ngược lại. Báo động, sửa tay, và sửa bằng một bút toán `adjust()` có `reason`, không bằng `UPDATE`.

Chạy ở chế độ chỉ-báo-động ít nhất một chu kỳ billing trước khi cho phép bất kỳ hành động tự động nào.

### Không nên tách

Đừng dựng `BillingModule` mới. `paid-invoice-sync`, `subscription-sync`, `free-plan-downgrade` **đã chính là** tầng billing. Đổi tên và di chuyển chúng lúc này chỉ tạo nhiễu diff mà không đổi được gì về đúng đắn.

---

## 9. Thứ tự thi hành

Trong bảy chỗ ghi credit, chỉ **một** cần sửa để diệt bug đang có.

**Bước 0 — gỡ phần cấp credit khỏi `free-plan-downgrade.service.ts`.**
Không cần `CreditService`. Không cần đổi schema. Không cần migration.
Kèm một test cho ca downgrade, xác nhận sổ khớp số dư.

Rồi mới dựng choke point:

1. Xóa `is_active`.
2. Dựng `CreditsModule` với `applyDelta` và unique index cho idempotency key.
3. Chuyển `paid-invoice-sync` sang delta + hai bút toán.
4. Chuyển hai strategy `customer.subscription.*` sang `revokeSubscriptionCredits`.
5. Chuyển `payment-intent-succeeded` sang `grantAddonCredits`.
6. Tước quyền ghi của `credit-reset.cron`.
7. Bật `credit-reconciliation.cron` ở chế độ báo động.
8. (Nếu chọn) migrate `addonCredits` thành hàng theo lô.
9. Thiết kế `consume` — bề mặt mới, không phải refactor.

> Refactor kiến trúc trên nền một bug đang sống là cách chắc chắn nhất để không biết cuối cùng thứ gì đã sửa được nó.

---

## 10. Edge case phải xử lý

| Ca | Ghi chú |
|---|---|
| **Wallet/nguồn credit chưa tồn tại** | Đang xảy ra thật: user 13 không có `CreditWallet` row, `updateMany` trả `count = 0`, code chỉ log rồi đi tiếp. Tạo ở lúc provision user, mọi thao tác dùng upsert. |
| **Client retry của chính request consume** | Timeout rồi gọi lại → trừ hai lần. Webhook idempotency không cứu được. Cần idempotency key ở tầng request. |
| **Consume xong, job phía sau hỏng** | Trừ credit rồi job sinh ảnh/gọi model lỗi. Cần *reserve → commit/release* hai pha, hoặc bút toán bù. Ca thường gặp nhất trong sản phẩm AI. |
| **Webhook `invoice.paid` của kỳ cũ về muộn** | Event *hợp lệ*, chỉ cũ. Khóa theo `eventId` cho nó đi qua. Cần kiểm tra đơn điệu theo `periodStart`. |
| **Cron reset và `invoice.paid` chạm cùng một kỳ** | Với gói tháng hai mốc rất gần nhau. Cùng khóa idempotency ngữ nghĩa → ai tới trước thắng, người sau no-op. |
| **Upgrade giữa kỳ** | User có 30, upgrade gói 500 → kết quả **500**, không phải 530. Hiện tại handler `customer.subscription.deleted` của sub cũ không tìm thấy row nên **không ghi bút toán forfeit** — 30 credit biến mất khỏi sổ. |
| **Deadlock khi consume nhiều lô** | Thứ tự khóa tất định: Subscription trước, rồi các lô add-on sắp theo `createdAt`, phá hòa bằng `id`. |
| **`charge.refunded`** | **Chưa có strategy nào.** Hoàn tiền add-on xong, user vẫn giữ credit. Nếu đã tiêu hết lô → số dư âm. Phải chọn chính sách (cho âm / từ chối refund / thu từ nguồn khác) *trước khi* mở tính năng. |
| **Expire vs Downgrade đang chồng nhau** | Sau khi `EXPIRED`, `downgradeToFree` vẫn chạy và cấp free credits, đưa status về `ACTIVE`. Phải quyết: hết hạn vì không trả tiền thì rơi về Free (có credit) hay về không-có-gói (0 credit)? |
| **Plan đổi `renewalCredits` sau khi user đã đăng ký** | Grandfathering hay không? Hiện đọc `plan.renewalCredits` sống. |
| **Subscription `PAST_DUE`** | Credit còn tiêu được không? Hiện tại là có. Viết chính sách ra. |
| **Migration** | Sổ đã lệch. **Đừng dựng lại lịch sử.** Chốt số dư hiện tại thành một bút toán `ADJUSTMENT` với `reason = migration_opening_balance`. Cố "sửa" quá khứ sẽ tạo ra một lịch sử vừa sai vừa trông có vẻ đúng. |

---

## 11. Khả năng mở rộng

### Gift / Referral / Promotion — đừng thêm bucket theo nguồn gốc

Ba loại đó là **provenance**, không phải **behavior**. Nếu cả ba đều "không hết hạn, tiêu sau cùng, không hoàn tiền" thì chúng giống hệt nhau về hành vi. Khác biệt sống trên `reason` của transaction, nơi báo cáo được mà không đụng schema.

> **Thêm bucket khi và chỉ khi hành vi khác nhau** ở một trong bốn trục: hạn dùng, thứ tự tiêu, khả năng hoàn tiền, khả năng thu hồi.

Lưu ý mâu thuẫn tiềm ẩn: nếu bonus **không** hết hạn và tiêu sau cùng, nó khác add-on ở đúng một điểm — add-on hoàn tiền được. Đó là lý do chính đáng để tách. Nhưng nó cũng nói rằng **thứ tự tiêu đang mã hóa một chính sách tài chính**: tiêu add-on trước bonus nghĩa là user xài hết credit đã trả tiền trước, nên khi họ đòi refund thì bạn nợ ít hơn. Lựa chọn có lợi cho bạn — hãy biết rằng bạn đang chọn nó.

Ngược lại, **nếu có bất kỳ loại bonus nào hết hạn**, thứ tự "bonus sau cùng" đảm bảo nó luôn hết hạn mà không được dùng. Lúc đó luật đúng là "sắp hết hạn trước", và mô hình đếm-theo-bucket bắt đầu vỡ. Đây là con đường khả dĩ nhất dẫn tới lot accounting.

### Nhiều payment provider

`CreditService` không quan tâm — nó chưa từng biết Stripe là ai. `referenceType`/`referenceId` đã đủ trừu tượng, và khớp đúng với `IPaymentAdapter` vừa tách. Đây là phần dễ nhất.

### Khi nào chuyển sang Wallet

Chuyển khi consume trở thành đường nóng và p99 quan trọng, hoặc số lô mỗi user phình ra khiến `SUM` và fanout khóa trở nên đắt.

Đường đi đúng khi đó **không phải** vứt lô đi, mà là: giữ lô làm nguồn sự thật, thêm một số dư tổng được vật chất hóa, cập nhật **trong cùng transaction** với lô, dùng **chỉ để đọc**, không bao giờ để ghi, và cho cron đối soát định kỳ.

Đó là Wallet đúng nghĩa — một *cache có kỷ luật*, không phải một nguồn sự thật thứ hai.

Vì `CreditService` đã là writer duy nhất, cú chuyển đó nằm gọn sau một biên giới. **Đó chính là giá trị lớn nhất của việc dựng choke point ngay bây giờ**, trước khi phải chọn giữa hai mô hình lưu trữ.
