import { Test, TestingModule } from '@nestjs/testing';
import { CreditService } from './credit.service';
import { CreditRepository } from './credit.repository';
import { PrismaService } from '../database/prisma.service';
import { InsufficientCreditsException } from './exceptions';
import { ReferenceType } from '@prisma/client';
import { randomUUID } from 'crypto';

describe('CreditService', () => {
  let service: CreditService;
  let prisma: PrismaService;
  let testUserId: number;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CreditService, CreditRepository, PrismaService],
    }).compile();

    service = module.get<CreditService>(CreditService);
    prisma = module.get<PrismaService>(PrismaService);

    // Create a mock user for testing
    const user = await prisma.user.create({
      data: {
        email: `test-${randomUUID()}@example.com`,
        password: 'password',
        name: 'Test User',
      }
    });
    testUserId = user.id;

    const planCode = `PRO_TEST_${randomUUID()}`;
    const plan = await prisma.plan.create({
      data: {
        code: planCode,
        name: 'Pro Test',
        renewalCredits: 100,
        resetIntervalDay: 30,
        isActive: true,
      }
    });

    const cycleName = `Monthly_${randomUUID()}`;
    const cycle = await prisma.billingCycle.create({
      data: {
        name: cycleName,
        durationDay: 30,
      }
    });

    const pricing = await prisma.pricingOption.create({
      data: {
        planId: plan.id,
        billingCycleId: cycle.id,
        name: 'Pro Monthly',
        price: 10,
        currency: 'USD',
        isActive: true,
      }
    });

    // Create subscription and wallet
    await prisma.subscription.create({
      data: {
        userId: testUserId,
        pricingOptionId: pricing.id,
        status: 'ACTIVE',
        subscriptionCreditsRemaining: 0,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(),
        nextCreditResetAt: new Date(),
      }
    });

    await prisma.creditWallet.create({
      data: {
        userId: testUserId,
        addonCredits: 0,
        is_active: true,
      }
    });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.creditTransaction.deleteMany({ where: { userId: testUserId } });
    await prisma.creditWallet.deleteMany({ where: { userId: testUserId } });
    await prisma.subscription.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset balances before each test
    await prisma.subscription.update({
      where: { userId: testUserId },
      data: { subscriptionCreditsRemaining: 0 },
    });
    await prisma.creditWallet.update({
      where: { userId: testUserId },
      data: { addonCredits: 0, is_active: true },
    });
    await prisma.creditTransaction.deleteMany({ where: { userId: testUserId } });
  });

  describe('grantSubscriptionAllowance', () => {
    it('should grant subscription credits and record transaction', async () => {
      await service.grantSubscriptionAllowance({
        userId: testUserId,
        amount: 100,
        description: 'Monthly grant',
        referenceId: 'sub_123',
        idempotencyKey: 'grant_1',
      });

      const balance = await service.getBalance(testUserId);
      expect(balance.subscription).toBe(100);

      const txs = await prisma.creditTransaction.findMany({ where: { userId: testUserId } });
      expect(txs).toHaveLength(1);
      expect(txs[0].type).toBe('RENEWAL');
      expect(txs[0].amount).toBe(100);
      expect(txs[0].referenceType).toBe(ReferenceType.SUBSCRIPTION);
    });

    it('should be idempotent', async () => {
      const cmd = {
        userId: testUserId,
        amount: 100,
        description: 'Monthly grant',
        referenceId: 'sub_123',
        idempotencyKey: 'grant_idemp',
      };
      await service.grantSubscriptionAllowance(cmd);
      await service.grantSubscriptionAllowance(cmd); // Should not throw, should be ignored

      const balance = await service.getBalance(testUserId);
      expect(balance.subscription).toBe(100); // Still 100, not 200
    });
  });

  describe('consume', () => {
    it('should consume from subscription first', async () => {
      await prisma.subscription.update({
        where: { userId: testUserId },
        data: { subscriptionCreditsRemaining: 100 },
      });
      await prisma.creditWallet.update({
        where: { userId: testUserId },
        data: { addonCredits: 50 },
      });

      const result = await service.consume({
        userId: testUserId,
        amount: 30,
        description: 'API Request',
        referenceId: 'req_1',
        idempotencyKey: 'req_1_key',
      });

      expect(result.fromSubscription).toBe(30);
      expect(result.fromAddon).toBe(0);
      expect(result.remainingSubscription).toBe(70);
      expect(result.remainingAddon).toBe(50);
    });

    it('should spill over to addon if subscription is insufficient', async () => {
      await prisma.subscription.update({
        where: { userId: testUserId },
        data: { subscriptionCreditsRemaining: 20 },
      });
      await prisma.creditWallet.update({
        where: { userId: testUserId },
        data: { addonCredits: 50 },
      });

      const result = await service.consume({
        userId: testUserId,
        amount: 30,
        description: 'API Request',
        referenceId: 'req_2',
        idempotencyKey: 'req_2_key',
      });

      expect(result.fromSubscription).toBe(20);
      expect(result.fromAddon).toBe(10);
      expect(result.remainingSubscription).toBe(0);
      expect(result.remainingAddon).toBe(40);
    });

    it('should throw InsufficientCreditsException if both are insufficient', async () => {
      await prisma.subscription.update({
        where: { userId: testUserId },
        data: { subscriptionCreditsRemaining: 10 },
      });
      await prisma.creditWallet.update({
        where: { userId: testUserId },
        data: { addonCredits: 5 },
      });

      await expect(
        service.consume({
          userId: testUserId,
          amount: 30,
          description: 'API Request',
          referenceId: 'req_3',
          idempotencyKey: 'req_3_key',
        }),
      ).rejects.toThrow(InsufficientCreditsException);

      // Balances should be unchanged
      const balance = await service.getBalance(testUserId);
      expect(balance.subscription).toBe(10);
      expect(balance.addon).toBe(5);
    });

    it('should not consume from addon if wallet is inactive', async () => {
      await prisma.subscription.update({
        where: { userId: testUserId },
        data: { subscriptionCreditsRemaining: 10 },
      });
      await prisma.creditWallet.update({
        where: { userId: testUserId },
        data: { addonCredits: 100, is_active: false },
      });

      await expect(
        service.consume({
          userId: testUserId,
          amount: 30,
          description: 'API Request',
          referenceId: 'req_4',
          idempotencyKey: 'req_4_key',
        }),
      ).rejects.toThrow(InsufficientCreditsException);

      const balance = await service.getBalance(testUserId);
      expect(balance.subscription).toBe(10); // Unchanged
      expect(balance.addon).toBe(100); // Unchanged
    });
  });
});
