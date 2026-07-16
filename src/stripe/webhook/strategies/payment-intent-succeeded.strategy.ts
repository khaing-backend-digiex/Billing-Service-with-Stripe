import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PrismaService } from "../../../database/prisma.service";
import { PaymentRecordService } from "../../payment-record.service";
import { CreditService } from "../../../credits/credit.service";
import { creditKey } from "../../../credits/credit.types";
import { STRIPE_METADATA_KEY } from "../../../common/constants/stripe.constants";

@Injectable()
export class PaymentIntentSucceededStrategy implements WebhookStrategy {
  private readonly logger = new Logger(PaymentIntentSucceededStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentRecordService,
    private readonly creditService: CreditService,
  ) {}

  private readonly paymentIntentSucceeded = "payment_intent.succeeded";
  canHandle(eventType: string): boolean {
    return eventType === this.paymentIntentSucceeded;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    this.logger.log(`payment_intent.succeeded: ${paymentIntent.id}`);

    const addonPackageId = paymentIntent.metadata?.[STRIPE_METADATA_KEY.ADDON_PACKAGE_ID];
    const userIdStr = paymentIntent.metadata?.[STRIPE_METADATA_KEY.USER_ID];

    if (!addonPackageId || !userIdStr) {
      this.logger.log(
        `Intent ${paymentIntent.id} is not an addon purchase – skipping`,
      );
      return;
    }
    const userId = userIdStr;

    if (await this.paymentService.isSucceeded(paymentIntent.id)) {
      this.logger.log(
        `Payment for intent ${paymentIntent.id} already SUCCEEDED – skipping`,
      );
      return;
    }

    const addon = await this.prisma.addonPackage.findUnique({
      where: { id: addonPackageId },
    });
    if (!addon) {
      this.logger.error(
        `Addon package ${addonPackageId} not found for intent ${paymentIntent.id}`,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const payment = await this.paymentService.recordSucceeded(
        {
          userId,
          providerPaymentId: paymentIntent.id,
          providerAmount: paymentIntent.amount_received,
          currency: paymentIntent.currency,
          addonPackageId,
        },
        tx,
      );

      const defaultProduct = await this.prisma.product.findFirst({ where: { code: 'AI' } });

      await this.creditService.grantAddonCredits(
        {
          userId,
          productId: defaultProduct?.id ?? addon.id,
          amount: addon.credits,
          description: `Purchased Addon: ${addon.name}`,
          referenceId: payment.id,
          idempotencyKey: creditKey.addonPurchase(paymentIntent.id),
        },
        tx,
      );
    });

    this.logger.log(
      `Addon credited: +${addon.credits} to user ${userId} (addon ${addon.code}, intent ${paymentIntent.id})`,
    );
  }
}
