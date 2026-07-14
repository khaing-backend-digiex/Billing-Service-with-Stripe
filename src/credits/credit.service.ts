import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreditRepository, TransactionEntry } from './credit.repository';
import { allocateCredits } from './credit-allocation';
import {
  CreditBalance,
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
  isAddonUsable,
} from './credit.types';
import { CreditTransactionType, ReferenceType } from '@prisma/client';
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
      const balances = await this.repo.lockForConsume(cmd.userId, client);

      const existing = await client.creditTransaction.findMany({
        where: {
          userId: cmd.userId,
          idempotencyKey: {
            startsWith: `${cmd.idempotencyKey}${KEY_SEPARATOR}`,
          },
        },
      });

      if (existing.length > 0) {
        let fromSub = 0;
        let fromAddon = 0;
        for (const tx of existing) {
           if (tx.referenceType === ReferenceType.SUBSCRIPTION) {
               fromSub += Math.abs(tx.amount);
           } else if (tx.referenceType === ReferenceType.ADDON_PURCHASE) {
               fromAddon += Math.abs(tx.amount);
           }
        }
        return {
          fromSubscription: fromSub,
          fromAddon: fromAddon,
          remainingSubscription: balances.subscriptionRemaining,
          remainingAddon: balances.addonCredits,
        };
      }

      // 2. Prepare allocation sources
      const sources: AllocationSource[] = [
        {
          bucket: ReferenceType.SUBSCRIPTION,
          available: balances.subscriptionRemaining,
        },
      ];
      if (balances.isActive && balances.addonCredits > 0) {
        sources.push({
          bucket: ReferenceType.ADDON_PURCHASE,
          available: balances.addonCredits,
        });
      }

      // 3. Allocate credits
      const allocation = allocateCredits(sources, cmd.amount);
      if (allocation.shortfall > 0) {
        throw new InsufficientCreditsException(
          `User ${cmd.userId} does not have enough credits. Required: ${cmd.amount}, Shortfall: ${allocation.shortfall}`
        );
      }

      // 4. Apply deltas (Single-step consume)
      let newSubRemaining = balances.subscriptionRemaining;
      let newAddonRemaining = balances.addonCredits;

      for (const alloc of allocation.allocations) {
        const entry: TransactionEntry = {
          type: CreditTransactionType.USAGE,
          bucket: alloc.bucket,
          amount: -alloc.amount,
          description: cmd.description,
          referenceId: cmd.referenceId,
          idempotencyKey: creditKey.bucketStep(cmd.idempotencyKey, alloc.bucket),
        };

        await this.repo.applyDelta(
          cmd.userId,
          -alloc.amount,
          entry,
          client,
        );

        if (alloc.bucket === ReferenceType.SUBSCRIPTION) {
          newSubRemaining -= alloc.amount;
        } else {
          newAddonRemaining -= alloc.amount;
        }
      }

      return {
        fromSubscription:
          allocation.allocations.find(
            (a) => a.bucket === ReferenceType.SUBSCRIPTION,
          )?.amount ?? 0,
        fromAddon:
          allocation.allocations.find(
            (a) => a.bucket === ReferenceType.ADDON_PURCHASE,
          )?.amount ?? 0,
        remainingSubscription: newSubRemaining,
        remainingAddon: newAddonRemaining,
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
      return this.repo.applyDelta(
        cmd.userId,
        cmd.amount,
        {
          type: CreditTransactionType.RENEWAL,
          bucket: ReferenceType.SUBSCRIPTION,
          amount: cmd.amount,
          description: cmd.description,
          referenceId: cmd.referenceId,
          idempotencyKey: cmd.idempotencyKey,
        },
        client,
      );
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
          description: cmd.revokeDescription,
          referenceId: cmd.referenceId,
          idempotencyKey: creditKey.revokeStep(cmd.idempotencyKey),
        },
        client,
      );

      return this.grantSubscriptionAllowance(
        {
          userId: cmd.userId,
          amount: cmd.amount,
          description: cmd.grantDescription,
          referenceId: cmd.referenceId,
          idempotencyKey: creditKey.grantStep(cmd.idempotencyKey),
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
      // Lock the row to prevent race conditions with concurrent consume operations
      const rows = await client.$queryRaw<[{ subscriptionCreditsRemaining: number }] | []>`
        SELECT "subscriptionCreditsRemaining"
        FROM "Subscription"
        WHERE "userId" = ${cmd.userId}
        FOR UPDATE
      `;

      const remaining = rows[0]?.subscriptionCreditsRemaining ?? 0;
      if (remaining <= 0) return true;

      return this.repo.applyDelta(
        cmd.userId,
        -remaining,
        {
          type: CreditTransactionType.EXPIRATION,
          bucket: ReferenceType.SUBSCRIPTION,
          amount: -remaining,
          description: cmd.description,
          referenceId: cmd.referenceId,
          idempotencyKey: `req:${cmd.userId}:${cmd.idempotencyKey}:revokeSub`,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async grantAddonCredits(
    cmd: GrantAddonCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      await client.creditWallet.upsert({
        where: { userId: cmd.userId },
        update: {},
        create: { userId: cmd.userId, addonCredits: 0 },
      });

      return this.repo.applyDelta(
        cmd.userId,
        cmd.amount,
        {
          type: CreditTransactionType.ADDON_PURCHASE,
          bucket: ReferenceType.ADDON_PURCHASE,
          amount: cmd.amount,
          description: cmd.description,
          referenceId: cmd.referenceId,
          idempotencyKey: `req:${cmd.userId}:${cmd.idempotencyKey}:grantAddon`,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  async getBalance(userId: string): Promise<CreditBalance> {
    const balances = await this.repo.getBalances(userId);

    return {
      subscription: balances.subscriptionRemaining,
      addon: balances.addonCredits,
      addonActive: balances.isActive,
      total:
        balances.subscriptionRemaining +
        (balances.isActive ? balances.addonCredits : 0),
    };
  }

  async getUserPackageStatus(userId: string): Promise<UserPackageStatus> {
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

    const wallet = await this.prisma.creditWallet.findUnique({
      where: { userId },
    });

    return {
      plan: subscription?.pricingOption?.plan?.name ?? 'Free',
      pricingOption: subscription?.pricingOption?.name ?? 'N/A',
      nextBillingDate: subscription?.currentPeriodEnd ?? null,
      subscriptionCredits: subscription?.subscriptionCreditsRemaining ?? 0,
      addonCredits: wallet?.addonCredits ?? 0,
      addonIsActive: isAddonUsable(
        subscription?.pricingOption?.plan?.code,
        subscription?.status,
      ),
    };
  }

  async adjust(cmd: AdjustCmd, tx?: TxClient): Promise<boolean> {
    const exec = async (client: TxClient) => {
      return this.repo.applyDelta(
        cmd.userId,
        cmd.amount,
        {
          type: CreditTransactionType.ADJUSTMENT,
          bucket: cmd.bucket,
          amount: cmd.amount,
          description: cmd.description,
          idempotencyKey: `req:${cmd.userId}:${cmd.idempotencyKey}:adjust`,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }
}
