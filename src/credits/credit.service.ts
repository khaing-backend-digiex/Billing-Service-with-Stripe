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
  GrantAddonCmd,
  AdjustCmd,
  AllocationSource,
  UserPackageStatus,
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
          idempotencyKey: `${cmd.idempotencyKey}:${alloc.bucket}`,
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

  async revokeSubscriptionCredits(
    cmd: RevokeSubscriptionCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      const sub = await client.subscription.findUnique({
        where: { userId: cmd.userId },
        select: { subscriptionCreditsRemaining: true },
      });

      const remaining = sub?.subscriptionCreditsRemaining ?? 0;
      if (remaining === 0) return true;

      return this.repo.applyDelta(
        cmd.userId,
        -remaining,
        {
          type: CreditTransactionType.EXPIRATION,
          bucket: ReferenceType.SUBSCRIPTION,
          amount: -remaining,
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

  async grantAddonCredits(
    cmd: GrantAddonCmd,
    tx?: TxClient,
  ): Promise<boolean> {
    const exec = async (client: TxClient) => {
      // Ensure wallet exists
      await client.creditWallet.upsert({
        where: { userId: cmd.userId },
        update: {},
        create: { userId: cmd.userId, addonCredits: 0, is_active: false },
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
          idempotencyKey: cmd.idempotencyKey,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }

  // ──────────────── QUERY ────────────────

  async getBalance(userId: number): Promise<CreditBalance> {
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

  async getUserPackageStatus(userId: number): Promise<UserPackageStatus> {
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
      addonIsActive: wallet?.is_active ?? false,
    };
  }

  // ──────────────── ADMIN ────────────────

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
          idempotencyKey: cmd.idempotencyKey,
        },
        client,
      );
    };

    if (tx) return exec(tx);
    return this.prisma.$transaction((client) => exec(client));
  }
}
