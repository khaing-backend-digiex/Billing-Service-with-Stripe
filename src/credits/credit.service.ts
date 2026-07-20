import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreditRepository, TransactionEntry, LockedGrant } from './credit.repository';
import { allocateCredits } from './credit-allocation';
import {
  ConsumeCmd,
  ConsumeResult,
  GrantSubscriptionCmd,
  RevokeSubscriptionCmd,
  ResetSubscriptionCmd,
  GrantAddonCmd,
  AdjustCmd,
  AllocationSource,
  UserPackageStatus,
  creditKey,
  isSubscriptionSource,
  KEY_SEPARATOR,
  isAddonUsable,
} from './credit.types';
import { CreditTransactionType, ReferenceType, CreditGrantSourceType, SubscriptionStatus } from '@prisma/client';
import { InsufficientCreditsException } from './exceptions';

type TxClient = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CreditRepository,
  ) {}

  async consume(cmd: ConsumeCmd, tx?: TxClient): Promise<ConsumeResult> {
    const exec = async (client: TxClient): Promise<ConsumeResult> => {
      // 1. Lock rows
      const balances = await this.repo.lockForConsume(cmd.userId, cmd.productId, client);

      const existing = await client.creditTransaction.findMany({
        where: {
          userId: cmd.userId,
          idempotencyKey: {
            startsWith: `${cmd.idempotencyKey}${KEY_SEPARATOR}`,
          },
        },
        include: { grant: true }
      });

      if (existing.length > 0) {
        let fromSub = 0;
        let fromAddon = 0;
        for (const tx of existing) {
           if (isSubscriptionSource(tx.grant?.sourceType)) {
               fromSub += Math.abs(tx.amount);
           } else {
               fromAddon += Math.abs(tx.amount);
           }
        }

        let remainingSub = 0;
        let remainingAddon = 0;
        for (const grant of balances.grants) {
          if (isSubscriptionSource(grant.sourceType)) remainingSub += grant.amountRemaining;
          else remainingAddon += grant.amountRemaining;
        }

        return {
          allocations: [],
          totalAllocated: fromSub + fromAddon,
          remainingSubscription: remainingSub,
          remainingAddon: remainingAddon,
        };
      }

      const sources: AllocationSource[] = [];
      for (const grant of balances.grants) {
        if (grant.sourceType === 'ADDON' && !balances.addonIsActive) {
           continue;
        }
        sources.push({
          grantId: grant.id,
          sourceType: grant.sourceType,
          available: grant.amountRemaining,
        });
      }

      const allocation = allocateCredits(sources, cmd.amount);
      if (allocation.shortfall > 0) {
        throw new InsufficientCreditsException(
          `User ${cmd.userId} does not have enough credits for product ${cmd.productId}. Required: ${cmd.amount}, Shortfall: ${allocation.shortfall}`
        );
      }

      for (const alloc of allocation.allocations) {
        const entry: TransactionEntry = {
          type: CreditTransactionType.USAGE,
          grantId: alloc.grantId,
          amount: -alloc.amount,
          description: cmd.description,
          referenceType: ReferenceType.MANUAL,
          referenceId: cmd.referenceId,
          idempotencyKey: creditKey.grantStepItem(cmd.idempotencyKey, alloc.grantId),
        };

        await this.repo.applyDelta(
          cmd.userId,
          -alloc.amount,
          entry,
          client,
        );
      }
      
      let remainingSub = 0;
      let remainingAddon = 0;
      for (const grant of balances.grants) {
        let finalAmt = grant.amountRemaining;
        const used = allocation.allocations.find(a => a.grantId === grant.id);
        if (used) finalAmt -= used.amount;

        if (isSubscriptionSource(grant.sourceType)) remainingSub += finalAmt;
        else remainingAddon += finalAmt;
      }

      return {
        allocations: allocation.allocations,
        totalAllocated: allocation.totalAllocated,
        remainingSubscription: remainingSub,
        remainingAddon: remainingAddon,
      };
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async grantSubscriptionAllowance(
    cmd: GrantSubscriptionCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      const existing = await client.creditTransaction.findUnique({
        where: { idempotencyKey: cmd.idempotencyKey },
        select: { id: true }
      });
      if (existing) return false;

      const grant = await client.creditGrant.create({
        data: {
          userId: cmd.userId,
          productId: cmd.productId,
          sourceType: cmd.sourceType,
          // Entity, không phải hoá đơn: reconcile hỏi "sub này đã được cấp cho kỳ này chưa",
          // nên grant phải neo vào chính sub đó mới trả lời được.
          sourceRef: cmd.subscriptionId,
          amountGranted: cmd.amount,
          amountRemaining: cmd.amount,
          expiresAt: cmd.expiresAt,
          priority: 10,
        }
      });

      await client.creditTransaction.create({
        data: {
          userId: cmd.userId,
          grantId: grant.id,
          type: CreditTransactionType.RENEWAL,
          amount: cmd.amount,
          description: cmd.description,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: cmd.subscriptionId,
          invoiceId: cmd.invoiceId,
          idempotencyKey: cmd.idempotencyKey,
        }
      });
      return true;
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async resetSubscriptionAllowance(
    cmd: ResetSubscriptionCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      await this.revokeSubscriptionCredits(
        {
          userId: cmd.userId,
          productId: cmd.productId,
          description: cmd.revokeDescription,
          subscriptionId: cmd.subscriptionId,
          idempotencyKey: creditKey.revokeStep(cmd.idempotencyKey),
        },
        client,
      );

      return this.grantSubscriptionAllowance(
        {
          userId: cmd.userId,
          productId: cmd.productId,
          amount: cmd.amount,
          description: cmd.grantDescription,
          subscriptionId: cmd.subscriptionId,
          // Reset là cron cấp trong kỳ, không có hoá đơn nào đứng sau — nên không invoiceId.
          sourceType: CreditGrantSourceType.SUBSCRIPTION_RESET,
          idempotencyKey: creditKey.grantStep(cmd.idempotencyKey),
          expiresAt: cmd.expiresAt,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async revokeSubscriptionCredits(
    cmd: RevokeSubscriptionCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      const grants = await this.repo.lockForRevokeSubscription(cmd.userId, cmd.productId, client);

      let revokedAny = false;
      for (const grant of grants) {
        if (grant.amountRemaining <= 0) continue;
        const entry: TransactionEntry = {
          type: CreditTransactionType.EXPIRATION,
          grantId: grant.id,
          amount: -grant.amountRemaining,
          description: cmd.description,
          referenceType: ReferenceType.SUBSCRIPTION,
          referenceId: cmd.subscriptionId,
          invoiceId: cmd.invoiceId,
          idempotencyKey: `req:${cmd.userId}:${cmd.idempotencyKey}:revokeSub:${grant.id}`,
        };
        await this.repo.applyDelta(cmd.userId, -grant.amountRemaining, entry, client);
        revokedAny = true;
      }
      return revokedAny;
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async grantAddonCredits(
    cmd: GrantAddonCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      const existing = await client.creditTransaction.findUnique({
        where: { idempotencyKey: cmd.idempotencyKey },
        select: { id: true }
      });
      if (existing) return false;

      const grant = await client.creditGrant.create({
        data: {
          userId: cmd.userId,
          productId: cmd.productId,
          sourceType: CreditGrantSourceType.ADDON,
          sourceRef: cmd.paymentId,
          amountGranted: cmd.amount,
          amountRemaining: cmd.amount,
          expiresAt: cmd.expiresAt,
          priority: 100,
        }
      });

      await client.creditTransaction.create({
        data: {
          userId: cmd.userId,
          grantId: grant.id,
          type: CreditTransactionType.ADDON_PURCHASE,
          amount: cmd.amount,
          description: cmd.description,
          referenceType: ReferenceType.ADDON_PURCHASE,
          referenceId: cmd.paymentId,
          idempotencyKey: cmd.idempotencyKey,
        }
      });
      return true;
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async getUserPackageStatus(userId: string): Promise<UserPackageStatus[]> {
    // In preparation for Step 3, we fetch all active subscriptions for the user
    const subscriptions = await this.prisma.subscription.findMany({
      where: { 
        userId,
        status: SubscriptionStatus.ACTIVE 
      },
      include: {
        pricingOption: {
          include: {
            plan: true,
          },
        },
      },
    });

    const grants = await this.prisma.creditGrant.groupBy({
      by: ['productId', 'sourceType'],
      where: { 
        userId,
        amountRemaining: { gt: 0 },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      },
      _sum: { amountRemaining: true },
    });

    const productCredits = new Map<string, { sub: number; addon: number }>();
    for (const g of grants) {
      const sum = g._sum.amountRemaining || 0;
      if (!productCredits.has(g.productId)) {
         productCredits.set(g.productId, { sub: 0, addon: 0 });
      }
      const data = productCredits.get(g.productId)!;
      if (isSubscriptionSource(g.sourceType)) data.sub += sum;
      else data.addon += sum;
    }
    
    const statuses: UserPackageStatus[] = [];
    
    for (const sub of subscriptions) {
       const productId = (sub as any).productId ?? sub.pricingOption.plan.productId;
       const credits = productCredits.get(productId) ?? { sub: 0, addon: 0 };

       statuses.push({
         productId,
         plan: sub.pricingOption.plan.name,
         pricingOption: sub.pricingOption.name,
         nextBillingDate: sub.currentPeriodEnd,
         subscriptionCredits: credits.sub,
         addonCredits: credits.addon,
        
         addonIsActive: isAddonUsable(sub.pricingOption.plan.isFree, sub.status),
       });

       productCredits.delete(productId);
    }
    
    for (const [productId, credits] of productCredits.entries()) {
       statuses.push({
         productId,
         plan: 'Free',
         pricingOption: 'Free',
         nextBillingDate: null,
         subscriptionCredits: credits.sub,
         addonCredits: credits.addon,
         addonIsActive: false,
       });
    }

    return statuses;
  }

  async adjust(cmd: AdjustCmd, tx?: TxClient): Promise<boolean> {
    const exec = async (client: TxClient) => {
      const existing = await client.creditTransaction.findUnique({
        where: { idempotencyKey: cmd.idempotencyKey },
        select: { id: true }
      });
      if (existing) return false;

      const grant = await client.creditGrant.create({
        data: {
          userId: cmd.userId,
          productId: cmd.productId,
          sourceType: cmd.sourceType,
          sourceRef: 'ADJUSTMENT',
          amountGranted: cmd.amount,
          amountRemaining: cmd.amount,
          priority: 50,
        }
      });

      await client.creditTransaction.create({
        data: {
          userId: cmd.userId,
          grantId: grant.id,
          type: CreditTransactionType.ADJUSTMENT,
          amount: cmd.amount,
          description: cmd.description,
          referenceType: ReferenceType.MANUAL,
          idempotencyKey: cmd.idempotencyKey,
        }
      });
      return true;
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }
}
