import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { UsersService } from "../users/users.service";
import { SubscriptionSyncService } from "../stripe/sync/subscription-sync.service";
import { PaidInvoiceSyncService } from "../stripe/sync/paid-invoice-sync.service";

const GRACE_MS = 15 * 60_000;
const BATCH_SIZE = 50;


@Injectable()
export class FreePlanReconciliationCron {
  private readonly logger = new Logger(FreePlanReconciliationCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
    private readonly subscriptionSync: SubscriptionSyncService,
    private readonly paidInvoiceSync: PaidInvoiceSyncService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        createdAt: { lt: new Date(Date.now() - GRACE_MS) },
        OR: [{ providerCustomerId: null }, { subscription: null }],
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE, 
    });

    if (users.length === 0) return;
    this.logger.log(`Free plan reconciliation: ${users.length} user(s) incomplete`);

    let created = 0;
    let healed = 0;
    for (const user of users) {
      try {
        let customerId = user.providerCustomerId;
        if (customerId && !(await this.stripeService.customerExists(customerId))) {
          this.logger.warn(
            `User ${user.id}: customer ${customerId} didn't exist`,
          );
          customerId = null;
        }

        if (!customerId) {
          customerId = await this.usersService.ensureStripeCustomerId(user);
        }

        const activeSub = await this.stripeService.findActiveSubscription(customerId);

        if (activeSub) {
          this.logger.warn(
            `User ${user.id}: active Stripe subscription ${activeSub.id} has no local row – healing from Stripe`,
          );
          const local = await this.subscriptionSync.syncFromStripe(activeSub);
          if (!local) continue; 
          const latestPaid = await this.stripeService.getLatestPaidInvoice(activeSub.id);
          if (latestPaid) {
            await this.paidInvoiceSync.applyPaidInvoice(latestPaid, activeSub.id);
          }
          healed++;
        } else {
          const freeSub = await this.stripeService.subscribeToFreePlan(customerId);
          if (freeSub) {
            created++;
            this.logger.log(`User ${user.id}: free subscription ${freeSub.id} created`);
          }
        }
      } catch (err) {
        this.logger.error(
          `Reconciliation failed for user ${user.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.logger.log(
      `Free plan reconciliation done: ${created} subscription(s) created, ${healed} healed from Stripe`,
    );
  }
}
