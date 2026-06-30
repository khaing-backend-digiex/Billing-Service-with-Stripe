import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { StripeService } from "../stripe.service";
import { PrismaService } from "../../database/prisma.service";
import { PaymentStatus, PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PricingService } from "../../pricing/pricing.service";

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
  ) {}

  async handleEvent(event: Stripe.Event): Promise<void> {
    // 1. Idempotency Check
    const existingEvent = await this.prisma.webhookEvent.findUnique({
      where: { eventId: event.id },
    });

    if (existingEvent) {
      this.logger.log(`Webhook event ${event.id} already processed. Skipping.`);
      return; // Idempotent: Ignore duplicate webhook
    }

    // 2. Mark event as processed (or start processing)
    await this.prisma.webhookEvent.create({
      data: {
        id: event.id,
        eventId: event.id,
        provider: PaymentProvider.STRIPE,
        eventType: event.type,
        payload: event as any,
        processedAt: new Date(),
      },
    });

    switch (event.type) {
      case "checkout.session.completed":
        await this.handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "invoice.paid":
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case "customer.subscription.deleted":
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      // Other events...
      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    this.logger.log(`Invoice paid: ${invoice.id}`);
    
    if (invoice.subscription) {
      const subscriptionId = invoice.subscription as string;
      const stripeSub = await this.stripeService.getCustomer(invoice.customer as string);
      
      const lineItem = invoice.lines.data[0];
      const priceId = lineItem.price?.id;

      if (!priceId) return;

      const pricingOption = await this.pricingService.findByProviderPriceId(priceId);
      if (!pricingOption) {
        this.logger.error(`Pricing option not found for priceId ${priceId}`);
        return;
      }

      const user = await this.prisma.user.findFirst({
        where: { providerCustomerId: invoice.customer as string }
      });

      if (!user) {
        this.logger.error(`User not found for customer ${invoice.customer}`);
        return;
      }

      // Upsert Subscription in DB
      const currentPeriodEnd = new Date(lineItem.period.end * 1000);
      const currentPeriodStart = new Date(lineItem.period.start * 1000);

      // Add resetIntervalDay from plan
      const resetIntervalDay = pricingOption.plan.resetIntervalDay;
      const nextCreditResetAt = new Date();
      nextCreditResetAt.setDate(nextCreditResetAt.getDate() + resetIntervalDay);

      await this.prisma.subscription.upsert({
        where: { userId: user.id },
        update: {
          pricingOptionId: pricingOption.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart,
          currentPeriodEnd,
          subscriptionCreditsRemaining: pricingOption.plan.renewalCredits,
          nextCreditResetAt,
          providerSubscriptionId: subscriptionId,
        },
        create: {
          userId: user.id,
          pricingOptionId: pricingOption.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart,
          currentPeriodEnd,
          subscriptionCreditsRemaining: pricingOption.plan.renewalCredits,
          nextCreditResetAt,
          provider: PaymentProvider.STRIPE,
          providerSubscriptionId: subscriptionId,
        }
      });
    }
  }

  private async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    this.logger.log(`Checkout session completed: ${session.id}`);

    const addonPackageId = session.metadata?.addonPackageId;
    const userIdStr = session.metadata?.userId;

    if (addonPackageId && userIdStr) {
      const userId = parseInt(userIdStr, 10);
      const addon = await this.prisma.addonPackage.findUnique({ where: { id: addonPackageId } });

      if (addon && !isNaN(userId)) {
        await this.prisma.creditWallet.upsert({
          where: { userId },
          update: { addonCredits: { increment: addon.credits } },
          create: { userId, addonCredits: addon.credits },
        });

        await this.prisma.creditTransaction.create({
          data: {
            userId,
            type: "ADDON_PURCHASE",
            amount: addon.credits,
            description: `Purchased Addon: ${addon.name}`,
            referenceType: "ADDON_PURCHASE",
            referenceId: session.id,
          }
        });

        this.logger.log(`✅ Added ${addon.credits} addon credits to user ${userId}`);
      }
    }
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    this.logger.log(`Subscription canceled: ${subscription.id}`);
    
    await this.prisma.subscription.updateMany({
      where: { providerSubscriptionId: subscription.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      }
    });
  }
}
