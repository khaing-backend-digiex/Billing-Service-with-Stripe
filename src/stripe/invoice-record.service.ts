import { Injectable, Logger } from "@nestjs/common";
import { Invoice, InvoiceStatus, PaymentProvider, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { PaymentInvoice } from "../payments/types/payment.types";
import { formatStripeAmountToDatabase } from "./utils/stripe-currency.util";


@Injectable()
export class InvoiceRecordService {
  private readonly logger = new Logger(InvoiceRecordService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  async ensureLocal(
    providerInvoice: PaymentInvoice,
    subscriptionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Invoice> {
    const sub = await this.db(tx).subscription.findUnique({
      where: { id: subscriptionId },
      select: { pricingOptionId: true },
    });

    return this.db(tx).invoice.upsert({
      where: { providerInvoiceId: providerInvoice.id },
      update: {},
      create: {
        ...this.createData(providerInvoice, subscriptionId),
        pricingOptionId: sub?.pricingOptionId,
      },
    });
  }

  
  async claimAsPaid(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    billingReason: string | null,
    paidAt: Date = new Date(),
  ): Promise<boolean> {
    const claimed = await tx.invoice.updateMany({
      where: { id: invoiceId, status: { not: InvoiceStatus.PAID } },
      data: {
        status: InvoiceStatus.PAID,
        billingReason,
        paidAt,
      },
    });

    return claimed.count > 0;
  }

  async recordFailedAttempt(
    tx: Prisma.TransactionClient,
    providerInvoice: PaymentInvoice,
    subscriptionId: string | null,
  ): Promise<Invoice | null> {
    const retryData = {
      status: InvoiceStatus.OPEN,
      retryCount: providerInvoice.attemptCount,
      nextRetryAt: providerInvoice.nextPaymentAttempt
        ? new Date(providerInvoice.nextPaymentAttempt * 1000)
        : null,
    };

    if (subscriptionId) {
      const sub = await tx.subscription.findUnique({
        where: { id: subscriptionId },
        select: { pricingOptionId: true },
      });

      return tx.invoice.upsert({
        where: { providerInvoiceId: providerInvoice.id },
        update: retryData,
        create: { 
          ...this.createData(providerInvoice, subscriptionId), 
          ...retryData,
          pricingOptionId: sub?.pricingOptionId,
        },
      });
    }

    const updated = await tx.invoice.updateMany({
      where: { providerInvoiceId: providerInvoice.id },
      data: retryData,
    });

    if (updated.count === 0) {
      this.logger.error(
        `No local invoice found for provider invoice ${providerInvoice.id}`,
      );
      return null;
    }

    return tx.invoice.findUnique({
      where: { providerInvoiceId: providerInvoice.id },
    });
  }

 
  async hasPriorPaidInvoice(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    excludeInvoiceId: string,
  ): Promise<boolean> {
    const count = await tx.invoice.count({
      where: {
        subscriptionId,
        status: InvoiceStatus.PAID,
        id: { not: excludeInvoiceId },
      },
    });

    return count > 0;
  }

  async markUncollectible(
    invoiceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.db(tx).invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.UNCOLLECTIBLE, nextRetryAt: null },
    });
  }

  private createData(
    providerInvoice: PaymentInvoice,
    subscriptionId: string,
  ): Prisma.InvoiceUncheckedCreateInput {
    return {
      subscriptionId,
      provider: PaymentProvider.STRIPE,
      providerInvoiceId: providerInvoice.id,
      amount: formatStripeAmountToDatabase(
        providerInvoice.amountDue,
        providerInvoice.currency,
      ),
      currency: providerInvoice.currency,
      billingReason: providerInvoice.billingReason ?? null,
      status: InvoiceStatus.OPEN,
      dueAt: providerInvoice.dueDate
        ? new Date(providerInvoice.dueDate * 1000)
        : new Date(providerInvoice.periodEnd * 1000),
    };
  }
}
