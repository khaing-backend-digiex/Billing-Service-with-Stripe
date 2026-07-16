import Stripe from 'stripe';

/**
 * Helper idempotency xuyên hệ thống cho catalog trên Stripe.
 *
 * Bài toán: DB reset được, Stripe thì KHÔNG. `migrate reset` xoá sạch DB, nhưng Product và
 * Price bên Stripe vẫn nằm đó. Upsert trong DB là dễ; khó là lần seed thứ hai không được
 * đẻ thêm một bộ Product/Price trùng nghĩa trong tài khoản Stripe.
 *
 * Vì sao không dùng PricingService: nó thuộc domain Billing/Catalog và API của nó có thể
 * đổi bất cứ lúc nào — seed hỏng theo. Ngoài ra `adapter.createProduct(name)` gọi phát nào
 * tạo Product mới phát đó (không idempotent) và `createRecurringPrice` không nhận
 * lookup_key, nên nó không làm được việc ở đây. Helper này gọi thẳng Stripe SDK.
 *
 * Vì sao không dùng `products.search`/`prices.search` như hướng ban đầu: Search API của
 * Stripe là eventually consistent (trễ index tới ~1 phút). Chạy seed hai lần liên tiếp thì
 * lần hai không thấy thứ lần một vừa tạo → tạo trùng. Ở đây dùng:
 *   - Product: id do ta tự đặt, `retrieve(id)` — tra chính xác, không qua index.
 *   - Price:  `lookup_key` + `prices.list({ lookup_keys })` — `list` là consistent,
 *             khác `search`. lookup_key là cơ chế Stripe sinh ra đúng cho việc này.
 */

export interface RecurringSpec {
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
}

/** Id Stripe Product suy ra từ catalog — phải ổn định qua mọi lần seed. */
export function stripeProductId(productCode: string, planCode: string): string {
  return `seed_${productCode}_${planCode}`.toLowerCase();
}

/** lookup_key của Price — duy nhất trong một tài khoản Stripe. */
export function stripePriceLookupKey(
  productCode: string,
  planCode: string,
  cycleName: string,
  currency: string,
): string {
  return `seed_${productCode}_${planCode}_${cycleName}_${currency}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

async function retrieveProduct(stripe: Stripe, id: string): Promise<Stripe.Product | null> {
  try {
    return await stripe.products.retrieve(id);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
      return null;
    }
    throw error;
  }
}

/**
 * Product với id tự đặt. Stripe cho phép chỉ định `id` khi tạo Product (khác hầu hết object
 * khác) — đó là thứ làm seed idempotent mà không cần search.
 */
export async function ensureStripeProduct(
  stripe: Stripe,
  id: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await retrieveProduct(stripe, id);
  if (!existing) {
    const created = await stripe.products.create({ id, name });
    return { id: created.id, created: true };
  }
  // Product bị archive thì Price của nó không dùng cho sub mới được. Seed là để có môi
  // trường chạy được, nên bật lại.
  if (!existing.active) {
    await stripe.products.update(id, { active: true });
  }
  return { id: existing.id, created: false };
}

function priceMatches(
  price: Stripe.Price,
  params: { productId: string; unitAmount: number; currency: string; recurring: RecurringSpec },
): boolean {
  const productId = typeof price.product === 'string' ? price.product : price.product.id;
  return (
    productId === params.productId &&
    price.unit_amount === params.unitAmount &&
    price.currency === params.currency &&
    price.recurring?.interval === params.recurring.interval &&
    price.recurring?.interval_count === params.recurring.intervalCount
  );
}

/**
 * Price khớp `lookup_key` thì tái dùng.
 *
 * Price của Stripe là BẤT BIẾN: không sửa được giá. Nên khi catalog đổi giá, cách đúng là
 * tạo Price mới và chuyển lookup_key sang (`transfer_lookup_key`) — key luôn trỏ tới bản
 * hiện hành, còn sub đang chạy trên Price cũ không bị động tới.
 */
export async function ensureStripeRecurringPrice(
  stripe: Stripe,
  params: {
    productId: string;
    lookupKey: string;
    unitAmount: number;
    currency: string;
    recurring: RecurringSpec;
  },
): Promise<{ id: string; created: boolean }> {
  const found = await stripe.prices.list({
    lookup_keys: [params.lookupKey],
    active: true,
    limit: 1,
  });
  const existing = found.data[0];
  if (existing && priceMatches(existing, params)) {
    return { id: existing.id, created: false };
  }

  const created = await stripe.prices.create({
    product: params.productId,
    unit_amount: params.unitAmount,
    currency: params.currency,
    recurring: {
      interval: params.recurring.interval,
      interval_count: params.recurring.intervalCount,
    },
    lookup_key: params.lookupKey,
    // Cướp key từ Price cũ nếu có. Không có cờ này, tạo Price trùng lookup_key là lỗi.
    transfer_lookup_key: true,
  });
  return { id: created.id, created: true };
}
