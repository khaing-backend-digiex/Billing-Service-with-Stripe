import { Injectable } from "@nestjs/common";
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


    await tx.creditGrant.update({
      where: { id: entry.grantId },
      data: {
        amountRemaining: { increment: delta },
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
    // We lock the single subscription to derive freeze status.
    // (In Step 3, this will also filter by productId once the Subscription model becomes multi-product).
    const subRows = await tx.$queryRaw<
      [{ status: SubscriptionStatus; isFree: boolean }] | []
    >`
      SELECT s."status", p."isFree" AS "isFree"
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
      addonIsActive: isAddonUsable(sub?.isFree, sub?.status),
    };
  }

  /**
   * Revoke quét CẢ HAI nguồn subscription: credit cấp theo hoá đơn và credit do cron reset
   * đều là credit của gói, hết kỳ là hết. Liệt kê thiếu một giá trị ở đây nghĩa là credit
   * kỳ cũ sống sót qua kỳ mới mà không ai thấy.
   */
  async lockForRevokeSubscription(userId: string, productId: string, tx: TxClient): Promise<LockedGrant[]> {
    const grantRows = await tx.$queryRaw<
      [{ id: string; sourceType: CreditGrantSourceType; amountRemaining: number }]
    >`
      SELECT "id", "sourceType", "amountRemaining"
      FROM "CreditGrant"
      WHERE "userId" = ${userId}
        AND "productId" = ${productId}
        AND "sourceType" = ANY(${SUBSCRIPTION_SOURCES}::"CreditGrantSourceType"[])
        AND "amountRemaining" > 0
      ORDER BY "priority" ASC, "expiresAt" ASC NULLS LAST, "id" ASC
      FOR UPDATE
    `;
    return grantRows || [];
  }
}
