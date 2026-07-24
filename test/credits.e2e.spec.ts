import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { TestContext } from './helpers/context';
import {
  CreditGrantSourceType,
  CreditTransactionType,
  SubscriptionStatus,
  User,
} from '@prisma/client';

/**
 * Số dư nằm ở CreditGrant – đây là chỗ duy nhất, Subscription không giữ cột số dư nào.
 *
 * Thứ tự tiêu giờ là DATA chứ không phải code: `lockForConsume` sắp
 * `priority ASC, expiresAt ASC NULLS LAST, id ASC`. Grant SUBSCRIPTION cấp ở priority 10,
 * ADDON ở 100 – nên "tiêu sub trước, hết mới tới addon" đúng vì hai con số đó, không phải
 * vì có nhánh if nào chọn bucket. Test dựng grant với đúng priority mà CreditService dùng.
 */
describe('CreditsController (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  const ctx = new TestContext();

  /**
   * `JwtAuthGuard` là APP_GUARD toàn cục, nên mọi request không kèm token đều nhận 401 –
   * kể cả trước khi ValidationPipe kịp chạy. Phải đăng nhập thật thì test mới chạm tới
   * controller. Controller lấy user từ token, KHÔNG lấy `userId` trong body.
   */
  const authFor = (user: User) =>
    `Bearer ${jwtService.sign({ sub: user.id, email: user.email, roles: user.roles })}`;

  /** Grant SUBSCRIPTION: CHECK `CreditGrant_source_ref_check` bắt buộc có sourceRef. */
  const giveSubCredits = (userId: string, subId: string, amount: number) =>
    ctx.createGrant(userId, {
      sourceType: CreditGrantSourceType.SUBSCRIPTION_ALLOCATION,
      sourceRef: subId,
      amountGranted: amount,
      priority: 10,
    });

  const giveAddonCredits = (userId: string, amount: number) =>
    ctx.createGrant(userId, {
      sourceType: CreditGrantSourceType.ADDON,
      amountGranted: amount,
      priority: 100,
    });

  const remainingOf = async (userId: string, sourceType: CreditGrantSourceType) => {
    const grants = await ctx.prisma.creditGrant.findMany({ where: { userId, sourceType } });
    return grants.reduce((n, g) => n + g.amountRemaining, 0);
  };

  beforeAll(async () => {
    await ctx.seed();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await ctx.cleanup();
    await app.close();
  });

  describe('POST /credits/consume', () => {
    it('returns 400 Bad Request if missing body parameters', async () => {
      const user = await ctx.createUser();
      return request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({})
        .expect(400);
    });

    it('returns 400 when productId is missing', async () => {
      // Credit luôn thuộc đúng một product (D5) – không có credit universal, nên request
      // không nói tiêu của product nào là request không trả lời được.
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      await giveSubCredits(user.id, sub.id, 10);

      return request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ amount: 1, idempotencyKey: 'e2e-no-product' })
        .expect(400);
    });

    it('consumes subscription credits if available', async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE });
      await giveSubCredits(user.id, sub.id, 10);
      await giveAddonCredits(user.id, 5);

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({
          productId: ctx.product.id,
          amount: 4,
          referenceId: 'test-gen',
          idempotencyKey: 'e2e-sub-only',
        })
        .expect(200);

      expect(res.body.data.totalAllocated).toBe(4);
      expect(res.body.data.remainingSubscription).toBe(6); // 10 - 4
      expect(res.body.data.remainingAddon).toBe(5); // chưa đụng tới

      expect(await ctx.subscriptionCredits(user.id)).toBe(6);
      expect(await remainingOf(user.id, CreditGrantSourceType.ADDON)).toBe(5);

      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.USAGE },
      });
      expect(txs).toHaveLength(1);
      expect(txs[0].amount).toBe(-4);
      expect(txs[0].referenceId).toBe('test-gen');
      // Mọi bút toán phải neo vào grant đã trừ – ledger truy được credit đi đâu.
      expect(txs[0].grantId).not.toBeNull();
    });

    it('consumes addon credits if subscription credits are exhausted', async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE });
      await giveSubCredits(user.id, sub.id, 2);
      await giveAddonCredits(user.id, 10);

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({
          productId: ctx.product.id,
          amount: 5,
          referenceId: 'test-gen-2',
          idempotencyKey: 'e2e-mixed',
        })
        .expect(200);

      expect(res.body.data.totalAllocated).toBe(5);
      expect(await ctx.subscriptionCredits(user.id)).toBe(0);
      expect(await remainingOf(user.id, CreditGrantSourceType.ADDON)).toBe(7); // 10 - (5-2)

      // Hai grant bị trừ → hai bút toán, mỗi cái neo vào grant của nó.
      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, type: CreditTransactionType.USAGE },
      });
      expect(txs).toHaveLength(2);
      expect(txs.reduce((n, t) => n + t.amount, 0)).toBe(-5);
    });

    it('does not spend credits of another product', async () => {
      // `CreditGrant.productId` bắt buộc (D5): credit của product này không cứu được
      // request của product kia, dù cùng một user.
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id);
      await giveSubCredits(user.id, sub.id, 100);
      const other = await ctx.createCatalogTree('consume_other');

      await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: other.product.id, amount: 1, idempotencyKey: 'e2e-other-product' })
        .expect(400);

      expect(await ctx.subscriptionCredits(user.id)).toBe(100);
    });

    it('returns 400 InsufficientCreditsException if completely insufficient', async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE });
      await giveSubCredits(user.id, sub.id, 1);
      await giveAddonCredits(user.id, 1);

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: ctx.product.id, amount: 5, idempotencyKey: 'e2e-insufficient' })
        .expect(400);

      expect(res.body.message).toContain('does not have enough credits');

      // Thiếu thì không trừ gì hết – không có chuyện tiêu một phần rồi báo lỗi.
      expect(await ctx.subscriptionCredits(user.id)).toBe(1);
      expect(await remainingOf(user.id, CreditGrantSourceType.ADDON)).toBe(1);
      const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id } });
      expect(txs).toHaveLength(0);
    });

    it('is idempotent on mixed-bucket retry without poisoning the transaction', async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, { status: SubscriptionStatus.ACTIVE });
      const subGrant = await giveSubCredits(user.id, sub.id, 4);
      const addonGrant = await giveAddonCredits(user.id, 10);

      // Lần 1: 4 từ sub, 6 từ addon.
      const res1 = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: ctx.product.id, amount: 10, idempotencyKey: 'retry-test-key' })
        .expect(200);

      expect(res1.body.data.totalAllocated).toBe(10);
      expect(res1.body.data.allocations).toHaveLength(2);

      // Đổi số dư để giả lập retry đến muộn khi bối cảnh đã khác: sub cạn, addon vừa được
      // nạp lại. Implementation idempotency tồi sẽ trừ thêm 10 lần nữa từ addon.
      await ctx.prisma.creditGrant.update({
        where: { id: subGrant.id },
        data: { amountRemaining: 0 },
      });
      await ctx.prisma.creditGrant.update({
        where: { id: addonGrant.id },
        data: { amountRemaining: 10 },
      });

      const res2 = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: ctx.product.id, amount: 10, idempotencyKey: 'retry-test-key' })
        .expect(200);

      // Trả lại con số của lần TIÊU GỐC, không tính lại theo số dư mới.
      expect(res2.body.data.totalAllocated).toBe(10);

      // Và không đẻ thêm bút toán nào.
      const prefix = `req:${user.id}:${ctx.product.id}:retry-test-key:consume:`;
      const txs = await ctx.prisma.creditTransaction.findMany({
        where: { userId: user.id, idempotencyKey: { startsWith: prefix } },
      });
      expect(txs).toHaveLength(2);
      expect(await remainingOf(user.id, CreditGrantSourceType.ADDON)).toBe(10); // không bị trừ lần hai
    });

    it('freezes addon credits when the user has no live paid subscription', async () => {
      // D7: rớt về Free thì add-on grant ĐÓNG BĂNG – không tiêu được, không mất.
      const user = await ctx.createUser();
      await ctx.createSubscription(user.id, {
        pricingOptionId: ctx.freeOption.id,
        status: SubscriptionStatus.ACTIVE,
      });
      await giveAddonCredits(user.id, 50);

      await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: ctx.product.id, amount: 1, idempotencyKey: 'e2e-frozen-addon' })
        .expect(400);

      // Đóng băng chứ không mất: grant còn nguyên.
      expect(await remainingOf(user.id, CreditGrantSourceType.ADDON)).toBe(50);
    });

    /**
     * D9: trong ân hạn PAST_DUE phải đóng băng TOÀN BỘ credit – cả subscription lẫn add-on –
     * để dùng freeze làm đòn bẩy thu tiền.
     *
     * TODO(PR3): hiện code chỉ freeze add-on qua `isAddonUsable`; credit SUBSCRIPTION vẫn
     * tiêu được khi PAST_DUE, nên test này sẽ đỏ. Không sửa ở đây: đổi điều kiện consume là
     * đổi business rule, thuộc PR3 (lifecycle) chứ không phải PR2 (dời số dư sang grant).
     * §14.2 của design doc đã ghi nhận đúng khoảng lệch này.
     */
    it.skip('freezes subscription credits too while PAST_DUE (D9 – chưa implement)', async () => {
      const user = await ctx.createUser();
      const sub = await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.PAST_DUE,
      });
      await giveSubCredits(user.id, sub.id, 10);

      await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', authFor(user))
        .send({ productId: ctx.product.id, amount: 1, idempotencyKey: 'e2e-pastdue-freeze' })
        .expect(400);

      expect(await ctx.subscriptionCredits(user.id)).toBe(10);
    });
  });
});
