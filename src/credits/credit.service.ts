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
  KEY_SEPARATOR,
} from './credit.types';
import { CreditTransactionType, ReferenceType, CreditGrantSourceType } from '@prisma/client';
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
           if (tx.grant?.sourceType === 'SUBSCRIPTION') {
               fromSub += Math.abs(tx.amount);
           } else {
               fromAddon += Math.abs(tx.amount);
           }
        }
        
        let remainingSub = 0;
        let remainingAddon = 0;
        for (const grant of balances.grants) {
          if (grant.sourceType === 'SUBSCRIPTION') remainingSub += grant.amountRemaining;
          else remainingAddon += grant.amountRemaining;
        }

        return {
          allocations: [],
          totalAllocated: fromSub + fromAddon,
          remainingSubscription: remainingSub,
          remainingAddon: remainingAddon,
        };
      }

      // 2. Prepare allocation sources
      const sources: AllocationSource[] = [];
      for (const grant of balances.grants) {
        if (grant.sourceType === 'ADDON' && !balances.addonIsActive) {
           continue; // Addon credits are frozen
        }
        sources.push({
          grantId: grant.id,
          sourceType: grant.sourceType,
          available: grant.amountRemaining,
        });
      }

      // 3. Allocate credits
      const allocation = allocateCredits(sources, cmd.amount);
      if (allocation.shortfall > 0) {
        throw new InsufficientCreditsException(
          `User ${cmd.userId} does not have enough credits for product ${cmd.productId}. Required: ${cmd.amount}, Shortfall: ${allocation.shortfall}`
        );
      }

      // 4. Apply deltas (Single-step consume)
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
        
        if (grant.sourceType === 'SUBSCRIPTION') remainingSub += finalAmt;
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
          sourceType: CreditGrantSourceType.SUBSCRIPTION,
          sourceRef: cmd.referenceId,
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
          referenceId: cmd.referenceId,
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
          referenceId: cmd.referenceId,
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
          referenceId: cmd.referenceId,
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
          referenceId: cmd.referenceId,
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
          sourceRef: cmd.referenceId,
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
          referenceId: cmd.referenceId,
          idempotencyKey: cmd.idempotencyKey,
        }
      });
      return true;
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async getUserPackageStatus(userId: string): Promise<UserPackageStatus[]> {
    // In Step 2, we return an array since the design is for multi-product.
    // However, since we haven't fully refactored Subscription to multi-product yet (Step 3),
    // we query grants grouped by productId and join with the single subscription for now.
    
    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
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
      where: { userId },
      _sum: { amountRemaining: true },
    });

    // Group sums by productId
    const productCredits = new Map<string, { sub: number; addon: number }>();
    for (const g of grants) {
      const sum = g._sum.amountRemaining || 0;
      if (!productCredits.has(g.productId)) {
         productCredits.set(g.productId, { sub: 0, addon: 0 });
      }
      const data = productCredits.get(g.productId)!;
      if (g.sourceType === 'SUBSCRIPTION') data.sub += sum;
      else data.addon += sum;
    }
    
    // We only have 1 subscription in this step. So we'll return an array of 1 for the subscription's product
    // plus any other products they have grants for.
    const statuses: UserPackageStatus[] = [];
    
    for (const [productId, credits] of productCredits.entries()) {
       // Is this product the one in the single subscription?
       // Currently, the single subscription has no productId. We'll just assume it applies to AI.
       // We'll return the sub status if it matches, else default.
       statuses.push({
         plan: subscription?.pricingOption?.plan?.name ?? 'Free',
         pricingOption: subscription?.pricingOption?.name ?? 'N/A',
         nextBillingDate: subscription?.currentPeriodEnd ?? null,
         subscriptionCredits: credits.sub,
         addonCredits: credits.addon,
         addonIsActive: true, // simplified for now
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
