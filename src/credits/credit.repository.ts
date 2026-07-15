import { Injectable } from "@nestjs/common";
import { CreditBucket, isAddonUsable } from "./credit.types";
import { PrismaService } from "../database/prisma.service";
import { CreditTransactionType, ReferenceType, SubscriptionStatus } from "@prisma/client";

type TxClient = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

export interface TransactionEntry {
  type: CreditTransactionType;
  bucket: CreditBucket;
  amount: number;
  description: string;
  referenceId?: string;
  idempotencyKey: string;
}

export interface LockedBalances {
  subscriptionRemaining: number;
  addonCredits: number;
  isActive: boolean;
}

@Injectable()
export class CreditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async applyDelta(
    userId: string,
    delta: number,
    entry: TransactionEntry,
    tx: TxClient,
  ): Promise<boolean> {
    // Check for existing transaction to avoid P2002 transaction poisoning
    if (entry.idempotencyKey) {
      const existing = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: entry.idempotencyKey },
        select: { id: true },
      });
      if (existing) {
        return false;
      }
    }

    // 1. Update balance
    if (entry.bucket === ReferenceType.SUBSCRIPTION) {
      await tx.subscription.update({
        where: { userId },
        data: {
          subscriptionCreditsRemaining: { increment: delta },
        },
      });
    } else {
      await tx.creditWallet.update({
        where: { userId },
        data: {
          addonCredits: { increment: delta },
        },
      });
    }

    // 2. log transaction
    await tx.creditTransaction.create({
      data: {
        userId,
        type: entry.type,
        amount: entry.amount,
        description: entry.description,
        referenceType: entry.bucket,
        referenceId: entry.referenceId,
        idempotencyKey: entry.idempotencyKey,
      },
    });

    return true;
  }

  async lockForConsume(userId: String, tx: TxClient): Promise<LockedBalances> {
    // Lock subscription row
    // `FOR UPDATE OF s`: chỉ khoá hàng Subscription. Để `FOR UPDATE` trần thì Postgres khoá
    // luôn PricingOption và Plan – mà Plan dùng chung cho MỌI user, tức là mọi người cùng gói
    // sẽ bị xếp hàng sau nhau.
    const subRows = await tx.$queryRaw<
      [{ subscriptionCreditsRemaining: number; status: SubscriptionStatus; planCode: string }] | []
    >`
      SELECT s."subscriptionCreditsRemaining", s."status", p."code" AS "planCode"
      FROM "Subscription" s
      JOIN "PricingOption" po ON po."id" = s."pricingOptionId"
      JOIN "Plan" p ON p."id" = po."planId"
      WHERE s."userId" = ${userId}
      FOR UPDATE OF s
    `;
    const sub = subRows[0] ?? null;

    // Lock wallet row
    const walletRows = await tx.$queryRaw<[{ addonCredits: number }] | []>`
      SELECT "addonCredits"
      FROM "CreditWallet"
      WHERE "userId" = ${userId}
      FOR UPDATE
    `;

    const wallet = walletRows[0] ?? null;

    return {
      subscriptionRemaining: sub?.subscriptionCreditsRemaining ?? 0,
      addonCredits: wallet?.addonCredits ?? 0,
      isActive: isAddonUsable(sub?.planCode, sub?.status),
    };
  }

  async getBalances(userId: string): Promise<LockedBalances> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: {
        subscriptionCreditsRemaining: true,
        status: true,
        pricingOption: { select: { plan: { select: { code: true } } } },
      },
    });

    const wallet = await this.prisma.creditWallet.findUnique({
      where: { userId },
      select: { addonCredits: true },
    });

    return {
      subscriptionRemaining: sub?.subscriptionCreditsRemaining ?? 0,
      addonCredits: wallet?.addonCredits ?? 0,
      isActive: isAddonUsable(sub?.pricingOption?.plan?.code, sub?.status),
    };
  }
}
