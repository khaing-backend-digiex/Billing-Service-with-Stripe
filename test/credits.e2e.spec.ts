import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { TestContext } from './helpers/context';
import { CreditTransactionType, SubscriptionStatus } from '@prisma/client';

describe('CreditsController (e2e)', () => {
  let app: INestApplication;
  const ctx = new TestContext();

  beforeAll(async () => {
    await ctx.seed();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await ctx.cleanup();
    await app.close();
  });

  describe('POST /credits/consume', () => {
    it('returns 400 Bad Request if missing body parameters', () => {
      return request(app.getHttpServer())
        .post('/credits/consume')
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

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .send({ userId: user.id, amount: 4, referenceId: 'test-gen' })
        .expect(200);

      expect(res.body.success).toBe(true);

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

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .send({ userId: user.id, amount: 5, referenceId: 'test-gen-2' })
        .expect(200);

      expect(res.body.success).toBe(true);

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

      const res = await request(app.getHttpServer())
        .post('/credits/consume')
        .send({ userId: user.id, amount: 5 })
        .expect(400);

      expect(res.body.message).toContain('does not have enough credits');

      // Assert no credits deducted
      const sub = await ctx.prisma.subscription.findUnique({ where: { userId: user.id } });
      expect(sub!.subscriptionCreditsRemaining).toBe(1); 
      const wallet = await ctx.prisma.creditWallet.findUnique({ where: { userId: user.id } });
      expect(wallet!.addonCredits).toBe(1); 
    });
  });
});
