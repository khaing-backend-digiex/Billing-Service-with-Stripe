import { Injectable } from "@nestjs/common";
import { isAddonUsable } from "./credit.types";
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
    if (entry.idempotencyKey) {
      const existing = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: entry.idempotencyKey },
        select: { id: true },
      });
      if (existing) {
        return false;
      }
    }

    // Update grant balance
    await tx.creditGrant.update({
      where: { id: entry.grantId },
      data: {
        amountRemaining: { increment: delta },
      },
    });

    // Log transaction
    await tx.creditTransaction.create({
      data: {
        userId,
        grantId: entry.grantId,
        type: entry.type,
        amount: entry.amount,
        description: entry.description,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        idempotencyKey: entry.idempotencyKey,
      },
    });

    return true;
  }

  async lockForConsume(userId: string, productId: string, tx: TxClient): Promise<LockedBalances> {
    const subRows = await tx.$queryRaw<
      [{ status: SubscriptionStatus; planCode: string }] | []
    >`
      SELECT s."status", p."code" AS "planCode"
      FROM "Subscription" s
      JOIN "PricingOption" po ON po."id" = s."pricingOptionId"
      JOIN "Plan" p ON p."id" = po."planId"
      WHERE s."userId" = ${userId}
      FOR UPDATE OF s
    `;
    const sub = subRows[0] ?? null;

    // Lock relevant grants
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
      addonIsActive: isAddonUsable(sub?.planCode, sub?.status),
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
        AND "sourceType" = 'SUBSCRIPTION'
        AND "amountRemaining" > 0
      ORDER BY "priority" ASC, "expiresAt" ASC NULLS LAST, "id" ASC
      FOR UPDATE
    `;
    return grantRows || [];
  }
}
