import { Injectable, Logger } from "@nestjs/common";
import { isAddonUsable, SUBSCRIPTION_SOURCES } from "./credit.types";
import { PrismaService } from "../database/prisma.service";
import { CreditTransactionType, CreditGrantSourceType, SubscriptionStatus, ReferenceType } from "@prisma/client";


type TxClient = Parameters<Parameters<PrismaService["$transaction"]>[0]>[0];

export interface TransactionEntry {
  type: CreditTransactionType;
  grantId: string;
  amount: number;
  description: string;
  referenceType?: ReferenceType;
  referenceId?: string;
  invoiceId?: string;
  idempotencyKey: string;
}

export interface LockedGrant {
  id: string;
  sourceType: CreditGrantSourceType;
  amountRemaining: number;
}

export interface LockedBalances {
  grants: LockedGrant[];
  addonIsActive: boolean;
  subscriptionIsActive: boolean;
}

@Injectable()
export class CreditRepository {
  private readonly logger = new Logger(CreditRepository.name);
  constructor(private readonly prisma: PrismaService) {}

  async applyDelta(
    userId: string,
    entry: TransactionEntry,
    tx: TxClient,
    expiresAt?: Date,
  ): Promise<boolean> {
    this.logger.log(`Applying delta for user ${userId}: ${entry.amount} credits, grantId=${entry.grantId}, type=${entry.type}, idempotencyKey=${entry.idempotencyKey}`);
    if (entry.idempotencyKey) {
      const existing = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: entry.idempotencyKey },
        select: { id: true },
      });
      if (existing) {
        return false;
      }
    }

    await tx.creditGrant.update({
      where: { id: entry.grantId },
      data: {
        amountRemaining: { increment: entry.amount },
        ...(expiresAt !== undefined && { expiresAt }),
      },
    });
    await tx.creditTransaction.create({
      data: {
        userId,
        grantId: entry.grantId,
        type: entry.type,
        amount: entry.amount,
        description: entry.description,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        invoiceId: entry.invoiceId,
        idempotencyKey: entry.idempotencyKey,
      },
    });

    return true;
  }

  async lockForConsume(userId: string, productId: string, tx: TxClient): Promise<LockedBalances> {
    const subRows = await tx.$queryRaw<
      [{ status: SubscriptionStatus; isFree: boolean }] | []
    >`
      SELECT s."status", p."isFree" AS "isFree"
      FROM "Subscription" s
      JOIN "PricingOption" po ON po."id" = s."pricingOptionId"
      JOIN "Plan" p ON p."id" = po."planId"
      WHERE s."userId" = ${userId} and s.status = ${SubscriptionStatus.ACTIVE} and po."productId" = ${productId}
      FOR UPDATE OF s
      LIMIT 1
    `;
    const sub = subRows[0] ?? null;

    const grantRows = await tx.$queryRaw<
      [{ id: string; sourceType: CreditGrantSourceType; amountRemaining: number }]
    >`
      SELECT "id", "sourceType", "amountRemaining"
      FROM "CreditGrant"
      WHERE "userId" = ${userId}
        AND "productId" = ${productId}
        AND "amountRemaining" > 0
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
      ORDER BY "priority" ASC, "expiresAt" ASC NULLS LAST, "id" ASC
      FOR UPDATE
    `;
    return {
      grants: grantRows || [],
      addonIsActive: isAddonUsable(sub?.isFree, sub?.status),
      subscriptionIsActive: sub != null,
    };
  }

  async lockForRevokeSubscription(userId: string, productId: string, tx: TxClient): Promise<LockedGrant[]> {
    const grantRows = await tx.$queryRaw<
      [{ id: string; sourceType: CreditGrantSourceType; amountRemaining: number }]
    >`
      SELECT "id", "sourceType", "amountRemaining"
      FROM "CreditGrant"
      WHERE "userId" = ${userId}
        AND "productId" = ${productId}
        AND "sourceType" = ANY(${SUBSCRIPTION_SOURCES}::"CreditGrantSourceType"[])
        AND "amountRemaining" >= 0
        AND "expiresAt" > NOW()
      ORDER BY "priority" ASC, "expiresAt" ASC NULLS LAST, "id" ASC
      FOR UPDATE
    `;
    return grantRows || [];
  }
}
