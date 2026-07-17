import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { WebhookStrategy } from "./webhook-strategy.interface";
import { PaymentProvider, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service";
import { PricingService } from "@/pricing/pricing.service";
import { PaidInvoiceSyncService } from "../../sync/paid-invoice-sync.service";
import { StripeService } from "../../stripe.service";

const LIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.TRIALING,
];
const TERMINAL_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.EXPIRED,
  SubscriptionStatus.CANCELLED,
];

@Injectable()
export class InvoicePaidStrategy implements WebhookStrategy {
  private readonly logger = new Logger(InvoicePaidStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
    private readonly stripeService: StripeService,
  ) {}

  private readonly invoicePaid = "invoice.paid";
  canHandle(eventType: string): boolean {
    return eventType === this.invoicePaid;
  }

  async handle(event: Stripe.Event): Promise<void> {
    const paidInvoice = this.stripeService.mapRawInvoice(event.data.object);
    const lineToUse =
      paidInvoice.lines.find(line => line.type === "subscription" && !line.isProration) ??
      paidInvoice.lines.find(line => !line.isProration && line.subscriptionId) ??
      paidInvoice.lines.find(line => line.type === "subscription") ?? 
      paidInvoice.lines[0];
    const stripeSubscriptionId = paidInvoice.subscriptionId ?? lineToUse?.subscriptionId ?? null;

    if (!stripeSubscriptionId) {
      this.logger.error(
        `Invoice ${paidInvoice.id} has no linked subscription, skipping`,
      );
      return;
    }

    if (!paidInvoice.customerId) {
      this.logger.error(`Invoice ${paidInvoice.id} has no customer, skipping`);
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { providerCustomerId: paidInvoice.customerId },
      select: { id: true },
    });

    if (!user) {
      this.logger.error(
        `No user found for Stripe customer ${paidInvoice.customerId}`,
      );
      return;
    }

    const priceId = lineToUse?.priceId;

    if (!priceId) {
      this.logger.error(`No price ID found in invoice lines.`);
      return;
    }

    const pricingOption =
      await this.pricingService.findByProviderPriceId(priceId);
    if (!pricingOption) {
      this.logger.error(`No pricing option found for priceId ${priceId}`);
      return;
    }

    const periodStart = new Date(paidInvoice.periodStart * 1000);
    const periodEnd = new Date(paidInvoice.periodEnd * 1000);

    const existing = await this.prisma.subscription.findFirst({
      where: { providerSubscriptionId: stripeSubscriptionId }
    });

    // Row terminal là BẤT BIẾN (§8). Không lọc status ở đây thì `invoice.paid` của một sub
    // đã chết sẽ kéo row về ACTIVE — kịch bản thật: sub Free bị hủy khi user lên Pro vẫn
    // gia hạn $0 và phát invoice.paid, làm row Free EXPIRED sống dậy bên cạnh row Pro đang
    // live → hai row live cùng (user, product) → vỡ partial unique index §13.1.
    if (existing && TERMINAL_STATUSES.includes(existing.status)) {
      this.logger.warn(
        `Subscription ${existing.id} is ${existing.status} – ignoring late invoice ` +
        `${paidInvoice.id} for dead Stripe subscription ${stripeSubscriptionId}`,
      );
      return;
    }

    let subscription;
    // Stripe sub bị thay thế bởi sub mới này — hủy SAU khi DB commit (xem dưới).
    let supersededStripeSubIds: string[] = [];

    if (existing) {
      subscription = await this.prisma.subscription.update({
        where: { id: existing.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          pricingOptionId: pricingOption.id,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextCreditResetAt: periodEnd,
        }
      });
    } else {
      const result = await this.prisma.$transaction(async (tx) => {
        // findMany trước updateMany: cần giữ lại providerSubscriptionId của các row sắp bị
        // thay thế thì mới biết phải hủy Stripe sub nào (updateMany không trả row).
        const superseded = await tx.subscription.findMany({
          where: {
            userId: user.id,
            productId: pricingOption.plan.productId,
            status: { in: LIVE_STATUSES },
          },
          select: { id: true, providerSubscriptionId: true },
        });

        await tx.subscription.updateMany({
          where: { id: { in: superseded.map((s) => s.id) } },
          data: { status: SubscriptionStatus.EXPIRED },
        });

        const created = await tx.subscription.create({
          data: {
            userId: user.id,
            productId: pricingOption.plan.productId,
            status: SubscriptionStatus.ACTIVE,
            pricingOptionId: pricingOption.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            nextCreditResetAt: periodEnd,
            provider: PaymentProvider.STRIPE,
            providerSubscriptionId: stripeSubscriptionId,
          }
        });

        return { created, superseded };
      });

      subscription = result.created;
      supersededStripeSubIds = result.superseded
        .map((s) => s.providerSubscriptionId)
        .filter((id): id is string => !!id && id !== stripeSubscriptionId);
    }

    await this.paidInvoiceSync.applyPaidInvoice(paidInvoice, subscription.id);

    // Hủy Stripe sub cũ (điển hình: sub Free giá 0) CHỈ sau khi DB đã commit — gọi Stripe là
    // side-effect không rollback được, đưa vào transaction thì transaction fail sẽ để lại
    // user không còn sub nào (§8). Lỗi ở đây không được làm fail webhook: credit đã cấp rồi,
    // ném lỗi chỉ khiến Stripe retry và cấp lại. Sub sót lại là việc của reconciliation cron.
    for (const supersededId of supersededStripeSubIds) {
      try {
        await this.stripeService.cancelSubscriptionNow(supersededId);
        this.logger.log(
          `Cancelled superseded Stripe subscription ${supersededId} (replaced by ${stripeSubscriptionId})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to cancel superseded Stripe subscription ${supersededId}: ` +
          `${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
