import { Injectable, Logger } from "@nestjs/common";
import { Payment, PaymentProvider, PaymentStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { formatStripeAmountToDatabase } from "./utils/stripe-currency.util";

export interface RecordPaymentInput {
  userId: string;
  providerPaymentId: string;
  providerAmount: number;
  currency: string;
  invoiceId?: string | null;
  addonPackageId?: string | null;
}

@Injectable()
export class PaymentRecordService {
  private readonly logger = new Logger(PaymentRecordService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async isSucceeded(
    providerPaymentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const existing = await this.db(tx).payment.findUnique({
      where: { providerPaymentId },
      select: { status: true },
    });

    return existing?.status === PaymentStatus.SUCCEEDED;
  }

  async recordSucceeded(
    input: RecordPaymentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment> {
    return this.db(tx).payment.upsert({
      where: { providerPaymentId: input.providerPaymentId },
      create: {
        ...this.createData(input),
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
      update: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
    });
  }

  async markFailed(
    providerPaymentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment | null> {
    const db = this.db(tx);
    const existing = await db.payment.findUnique({
      where: { providerPaymentId },
    });

    if (!existing) return null;

    if (existing.status === PaymentStatus.SUCCEEDED) {
      this.logger.log(
        `Payment ${providerPaymentId} already SUCCEEDED – ignoring failure event`,
      );
      return existing;
    }

    return db.payment.update({
      where: { providerPaymentId },
      data: { status: PaymentStatus.FAILED },
    });
  }

  async recordFailed(
    input: RecordPaymentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment> {
    return this.db(tx).payment.create({
      data: { ...this.createData(input), status: PaymentStatus.FAILED },
    });
  }

  private createData(
    input: RecordPaymentInput,
  ): Omit<Prisma.PaymentUncheckedCreateInput, "status"> {
    return {
      userId: input.userId,
      providerPaymentId: input.providerPaymentId,
      provider: PaymentProvider.STRIPE,
      amount: formatStripeAmountToDatabase(input.providerAmount, input.currency),
      currency: input.currency,
      invoiceId: input.invoiceId ?? null,
      addonPackageId: input.addonPackageId ?? null,
    };
  }
}
