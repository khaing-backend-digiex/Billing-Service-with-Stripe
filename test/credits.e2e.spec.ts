import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { TestContext } from './helpers/context';
import { CreditTransactionType, SubscriptionStatus } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

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

  beforeAll(async () => {
    await ctx.seed();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    jwtService = moduleFixture.get(JwtService);
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
      const token = jwtService.sign({ sub: user.id, email: user.email, roles: ['user'] });
      return request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('consumes subscription credits if available', async () => {
      const user = await ctx.createUser();
      await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.ACTIVE,
        subscriptionCreditsRemaining: 10,
      });
      await ctx.prisma.creditWallet.create({
        data: { userId: user.id, addonCredits: 5 },
      });

      const token = jwtService.sign({ sub: user.id, email: user.email, roles: ['user'] });
      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id, amount: 4, referenceId: 'test-gen' })
        .expect(200);

      const sub = await ctx.prisma.subscription.findUnique({ where: { userId: user.id } });
      expect(sub!.subscriptionCreditsRemaining).toBe(6); // 10 - 4

      const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id, type: CreditTransactionType.USAGE }});
      expect(txs).toHaveLength(1);
      expect(txs[0].amount).toBe(-4);
      expect(txs[0].referenceId).toBe('test-gen');
    });

    it('consumes addon credits if subscription credits are exhausted', async () => {
      const user = await ctx.createUser();
      await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.ACTIVE,
        subscriptionCreditsRemaining: 2,
      });
      await ctx.prisma.creditWallet.create({
        data: { userId: user.id, addonCredits: 10, is_active: true },
      });

      const token = jwtService.sign({ sub: user.id, email: user.email, roles: ['user'] });
      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id, amount: 5, referenceId: 'test-gen-2' })
        .expect(200);

      const sub = await ctx.prisma.subscription.findUnique({ where: { userId: user.id } });
      expect(sub!.subscriptionCreditsRemaining).toBe(0); 

      const wallet = await ctx.prisma.creditWallet.findUnique({ where: { userId: user.id } });
      expect(wallet!.addonCredits).toBe(7); // 10 - 3 (5 total - 2 from sub)
    });

    it('returns 400 InsufficientCreditsException if completely insufficient', async () => {
      const user = await ctx.createUser();
      await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.ACTIVE,
        subscriptionCreditsRemaining: 1,
      });
      await ctx.prisma.creditWallet.create({
        data: { userId: user.id, addonCredits: 1 },
      });

      const token = jwtService.sign({ sub: user.id, email: user.email, roles: ['user'] });
      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id, amount: 5 })
        .expect(400);

      expect(res.body.message).toContain('does not have enough credits');

      // Assert no credits deducted
      const sub = await ctx.prisma.subscription.findUnique({ where: { userId: user.id } });
      expect(sub!.subscriptionCreditsRemaining).toBe(1); 
      const wallet = await ctx.prisma.creditWallet.findUnique({ where: { userId: user.id } });
      expect(wallet!.addonCredits).toBe(1); 
    });

    it('is idempotent on mixed-bucket retry without poisoning the transaction', async () => {
      const user = await ctx.createUser();
      await ctx.createSubscription(user.id, {
        status: SubscriptionStatus.ACTIVE,
        subscriptionCreditsRemaining: 4,
      });
      await ctx.prisma.creditWallet.create({
        data: { userId: user.id, addonCredits: 10, is_active: true },
      });

      // First request: uses 4 sub, 6 addon
      const token = jwtService.sign({ sub: user.id, email: user.email, roles: ['user'] });
      const res1 = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id, amount: 10, idempotencyKey: 'retry-test-key' })
        .expect(200);
      
      expect(res1.body.data.fromSubscription).toBe(4);
      expect(res1.body.data.fromAddon).toBe(6);

      // Now we intentionally change the balance to simulate a race or a later retry where balances differ.
      // E.g., subscription is now 0, addon is 10.
      // A bad idempotency implementation would try to draw 10 from addon, generate a new key, and double-deduct!
      // Or it would hit P2002 and poison the transaction.
      await ctx.prisma.creditWallet.update({
        where: { userId: user.id },
        data: { addonCredits: 10 }
      });
      await ctx.prisma.subscription.update({
        where: { userId: user.id },
        data: { subscriptionCreditsRemaining: 0 }
      });

      // Second request (retry)
      const res2 = await request(app.getHttpServer())
        .post('/credits/consume')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: user.id, amount: 10, idempotencyKey: 'retry-test-key' })
        .expect(200);

      // It should gracefully return the ORIGINAL consumption amounts!
      expect(res2.body.data.fromSubscription).toBe(4);
      expect(res2.body.data.fromAddon).toBe(6);

      // And no additional ledger entries should have been created
      const txs = await ctx.prisma.creditTransaction.findMany({ where: { userId: user.id, idempotencyKey: { startsWith: `req:${user.id}:retry-test-key:consume:` } }});
      expect(txs).toHaveLength(2); // Only the original two entries
    });
  });
});
