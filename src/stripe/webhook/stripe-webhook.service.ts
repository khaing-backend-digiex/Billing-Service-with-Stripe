import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from '../stripe.service';
import { PrismaService } from '../../database/prisma.service';
import {
  PaymentProvider,
  SubscriptionStatus,
  InvoiceStatus,
  PaymentStatus,
  CreditTransactionType,
  ReferenceType,
  SubscriptionEventType,
} from '@prisma/client';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
  ) {}

  async handleEvent(event: Stripe.Event): Promise<void> {
    // 1. Idempotency check
    const existingEvent = await this.prisma.webhookEvent.findUnique({
      where: { eventId: event.id },
    });

    if (existingEvent) {
      this.logger.log('Skipping duplicate webhook event: ' + event.id);
      return;
    }

    // Insert as unprocessed
    await this.prisma.webhookEvent.create({
      data: {
        id: event.id,
        eventId: event.id,
        provider: PaymentProvider.STRIPE,
        eventType: event.type,
        payload: event as any,
      },
    });

    try {
      // 2. Route to handler
      switch (event.type) {
        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(
            event.data.object as Stripe.Invoice,
          );
          break;

        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(
            event.data.object as Stripe.Invoice,
          );
          break;

        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(
            event.data.object as Stripe.Subscription,
          );
          break;

        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(
            event.data.object as Stripe.Subscription,
          );
          break;

        default:
          this.logger.log('Unhandled event type: ' + event.type);
      }

      // Mark as processed
      await this.prisma.webhookEvent.update({
        where: { eventId: event.id },
        data: { processedAt: new Date() },
      });
    } catch (error) {
      this.logger.error('Error processing webhook event ' + event.id + ':', error);
      throw error;
    }
  }

  private async handleInvoicePaymentSucceeded(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    const { billing_reason, subscription: subscriptionIdStr, customer } = invoice;
    const providerSubscriptionId = subscriptionIdStr as string;
    const providerCustomerId = customer as string;

    if (!providerSubscriptionId) {
      return;
    }

    if (
      billing_reason !== 'subscription_cycle' &&
      billing_reason !== 'subscription_create'
    ) {
      this.logger.log('Ignoring invoice payment succeeded for reason: ' + billing_reason);
      return;
    }

    const isRenewal = billing_reason === 'subscription_cycle';

    // Retrieve from Stripe
    const stripeSubscription = await this.stripeService.retrieveSubscription(
      providerSubscriptionId,
    );

    // Get userId from Prisma User
    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId },
    });
    if (!user) {
      this.logger.warn('User not found for Stripe customer ' + providerCustomerId);
      return;
    }
    const userId = user.id;

    if (!isRenewal) {
      // Create Subscription flow
      const priceId = stripeSubscription.items.data[0].price.id;
      const pricingOption = await this.prisma.pricingOption.findFirst({
        where: { providerPriceId: priceId },
        include: { plan: true },
      });

      if (!pricingOption) {
        this.logger.error('Pricing option not found for price ' + priceId);
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        const sub = await tx.subscription.create({
          data: {
            userId,
            pricingOptionId: pricingOption.id,
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
            currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
            nextCreditResetAt: new Date(stripeSubscription.current_period_end * 1000),
            subscriptionCreditsRemaining: pricingOption.plan.renewalCredits,
            provider: PaymentProvider.STRIPE,
            providerSubscriptionId,
          },
        });

        await this.upsertInvoice(tx, invoice, sub.id, InvoiceStatus.PAID);
        await this.insertPayment(tx, invoice, userId, PaymentStatus.SUCCEEDED);
        await this.insertCreditTransaction(
          tx,
          userId,
          CreditTransactionType.RENEWAL,
          pricingOption.plan.renewalCredits,
          sub.id,
        );
        await this.insertSubscriptionEvent(tx, sub.id, SubscriptionEventType.CREATED, pricingOption.id);
      });
      this.logger.log('First subscription created for user ' + userId);
    } else {
      // Renewal flow
      const existingSub = await this.prisma.subscription.findFirst({
        where: { providerSubscriptionId },
        include: { pricingOption: { include: { plan: true } } },
      });

      if (!existingSub) {
        this.logger.error('Subscription not found: ' + providerSubscriptionId);
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        const sub = await tx.subscription.update({
          where: { id: existingSub.id },
          data: {
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
            currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
            nextCreditResetAt: new Date(stripeSubscription.current_period_end * 1000),
            subscriptionCreditsRemaining: existingSub.pricingOption.plan.renewalCredits,
          },
        });

        await this.upsertInvoice(tx, invoice, sub.id, InvoiceStatus.PAID);
        await this.insertPayment(tx, invoice, userId, PaymentStatus.SUCCEEDED);
        await this.insertCreditTransaction(
          tx,
          userId,
          CreditTransactionType.RENEWAL,
          existingSub.pricingOption.plan.renewalCredits,
          sub.id,
        );
        await this.insertSubscriptionEvent(tx, sub.id, SubscriptionEventType.RENEWED, existingSub.pricingOption.id);
      });
      this.logger.log('Subscription renewed for user ' + userId);
    }
  }

  private async handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
  ): Promise<void> {
    const providerSubscriptionId = invoice.subscription as string;
    if (!providerSubscriptionId) return;

    const existingSub = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId },
    });

    if (!existingSub) return;

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: invoice.customer as string },
    });
    if (!user) return;
    const userId = user.id;

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: existingSub.id },
        data: { status: SubscriptionStatus.PAST_DUE },
      });

      await this.upsertInvoice(tx, invoice, existingSub.id, InvoiceStatus.OPEN);
      await this.insertPayment(tx, invoice, userId, PaymentStatus.FAILED);
      await this.insertSubscriptionEvent(tx, existingSub.id, SubscriptionEventType.PAYMENT_FAILED, existingSub.pricingOptionId);
    });

    this.logger.log('Subscription past due for user ' + userId);
  }

  private async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const existingSub = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: subscription.id },
    });

    if (!existingSub) return;

    let status: SubscriptionStatus = SubscriptionStatus.ACTIVE;
    switch (subscription.status) {
      case 'active': status = SubscriptionStatus.ACTIVE; break;
      case 'past_due': status = SubscriptionStatus.PAST_DUE; break;
      case 'canceled': status = SubscriptionStatus.CANCELLED; break;
      case 'trialing': status = SubscriptionStatus.TRIALING; break;
      case 'paused': status = SubscriptionStatus.PAUSED; break;
      case 'unpaid': status = SubscriptionStatus.EXPIRED; break;
    }

    await this.prisma.subscription.update({
      where: { id: existingSub.id },
      data: {
        status,
        autoRenew: !subscription.cancel_at_period_end,
      },
    });
    this.logger.log('Subscription ' + subscription.id + ' status synced to ' + status);
  }

  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const existingSub = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: subscription.id },
    });

    if (!existingSub) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: existingSub.id },
        data: {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: new Date(),
          autoRenew: false,
        },
      });

      await this.insertSubscriptionEvent(tx, existingSub.id, SubscriptionEventType.CANCELLED, existingSub.pricingOptionId);
    });

    this.logger.log('Subscription ' + subscription.id + ' cancelled');
  }

  // Helpers for transactions

  private async upsertInvoice(tx: any, invoice: Stripe.Invoice, subId: string, status: InvoiceStatus) {
    const providerInvoiceId = invoice.id;
    const amount = (invoice.amount_due || 0) / 100;
    const currency = invoice.currency || 'usd';

    const existing = await tx.invoice.findFirst({
      where: { providerInvoiceId },
    });

    if (existing) {
      await tx.invoice.update({
        where: { id: existing.id },
        data: {
          status,
          paidAt: status === InvoiceStatus.PAID ? new Date() : null,
          retryCount: invoice.attempt_count,
          nextRetryAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
        },
      });
    } else {
      await tx.invoice.create({
        data: {
          subscriptionId: subId,
          provider: PaymentProvider.STRIPE,
          providerInvoiceId,
          amount,
          currency,
          status,
          dueAt: new Date(invoice.created * 1000),
          paidAt: status === InvoiceStatus.PAID ? new Date() : null,
          retryCount: invoice.attempt_count,
          nextRetryAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
        },
      });
    }
  }

  private async insertPayment(tx: any, invoice: Stripe.Invoice, userId: string, status: PaymentStatus) {
    const providerPaymentId = (invoice.payment_intent as string) || ('fake_' + invoice.id);
    const amount = (invoice.amount_paid || invoice.amount_due || 0) / 100;
    const currency = invoice.currency || 'usd';

    // Ignore duplicate payments if Stripe retries same intent
    const existing = await tx.payment.findUnique({
      where: { providerPaymentId },
    });
    if (!existing) {
      await tx.payment.create({
        data: {
          userId,
          provider: PaymentProvider.STRIPE,
          providerPaymentId,
          amount,
          currency,
          status,
          paidAt: status === PaymentStatus.SUCCEEDED ? new Date() : null,
        },
      });
    } else if (status === PaymentStatus.SUCCEEDED && existing.status !== PaymentStatus.SUCCEEDED) {
      await tx.payment.update({
        where: { providerPaymentId },
        data: { status, paidAt: new Date() },
      });
    }
  }

  private async insertCreditTransaction(tx: any, userId: string, type: CreditTransactionType, amount: number, subId: string) {
    await tx.creditTransaction.create({
      data: {
        userId,
        type,
        amount,
        referenceType: ReferenceType.SUBSCRIPTION,
        referenceId: subId,
      },
    });
  }

  private async insertSubscriptionEvent(tx: any, subId: string, type: SubscriptionEventType, pricingOptionId: string) {
    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: subId,
        type,
        newPricingOptionId: pricingOptionId,
      },
    });
  }
}

