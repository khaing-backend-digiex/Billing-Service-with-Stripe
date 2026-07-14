import { Injectable } from "@nestjs/common";
import { CreditBucket } from "./credit.types";
import { PrismaService } from "../database/prisma.service";
import { CreditTransactionType, ReferenceType, Prisma } from "@prisma/client";

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
  hasWallet: boolean;
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
    const subRows = await tx.$queryRaw<
      [{ subscriptionCreditsRemaining: number }] | []
    >`
      SELECT "subscriptionCreditsRemaining"
      FROM "Subscription"
      WHERE "userId" = ${userId}
      FOR UPDATE
    `;
    const sub = subRows[0] ?? null;

    // Lock wallet row
    const walletRows = await tx.$queryRaw<
      [{ addonCredits: number; is_active: boolean }] | []
    >`
      SELECT "addonCredits", "is_active"
      FROM "CreditWallet"
      WHERE "userId" = ${userId}
      FOR UPDATE
    `;

    const wallet = walletRows[0] ?? null;

    return {
      subscriptionRemaining: sub?.subscriptionCreditsRemaining ?? 0,
      addonCredits: wallet?.addonCredits ?? 0,
      isActive: wallet?.is_active ?? false,
      hasWallet: wallet !== null,
    };
  }

  async getBalances(userId: string): Promise<LockedBalances> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { subscriptionCreditsRemaining: true },
    });

    const wallet = await this.prisma.creditWallet.findUnique({
      where: { userId },
      select: { addonCredits: true, is_active: true },
    });

    return {
      subscriptionRemaining: sub?.subscriptionCreditsRemaining ?? 0,
      addonCredits: wallet?.addonCredits ?? 0,
      isActive: wallet?.is_active ?? false,
      hasWallet: wallet !== null,
    };
  }
}
