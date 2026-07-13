import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { ReferenceType } from '@prisma/client';

@Injectable()
export class CreditReconciliationCron {
  private readonly logger = new Logger(CreditReconciliationCron.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async run() {
    this.logger.log('Starting daily credit reconciliation check...');
    
    // Get all users who have subscriptions or credit wallets
    const users = await this.prisma.user.findMany({
      select: { id: true },
      where: {
        OR: [
          { subscription: { isNot: null } },
          { creditWallet: { isNot: null } },
        ]
      }
    });

    for (const user of users) {
      await this.reconcileUser(user.id);
    }
    
    this.logger.log('Finished daily credit reconciliation check.');
  }

  private async reconcileUser(userId: string) {
    // 1. Get current balances
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { subscriptionCreditsRemaining: true }
    });
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { userId },
      select: { addonCredits: true }
    });

    const currentSubBalance = sub?.subscriptionCreditsRemaining ?? 0;
    const currentAddonBalance = wallet?.addonCredits ?? 0;

    if (currentSubBalance < 0) {
      this.logger.error(`[ALARM] User ${userId} has negative subscription balance: ${currentSubBalance}`);
    }
    if (currentAddonBalance < 0) {
      this.logger.error(`[ALARM] User ${userId} has negative addon balance: ${currentAddonBalance}`);
    }

    // 2. Sum up all transactions for SUBSCRIPTION bucket
    const subTxs = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId, referenceType: ReferenceType.SUBSCRIPTION }
    });
    const subTxSum = subTxs._sum.amount ?? 0;

    if (subTxSum !== currentSubBalance) {
      this.logger.error(`[ALARM] User ${userId} subscription balance mismatch! DB Balance: ${currentSubBalance}, TX Sum: ${subTxSum}`);
    }

    // 3. Sum up all transactions for ADDON_PURCHASE bucket
    const addonTxs = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId, referenceType: ReferenceType.ADDON_PURCHASE }
    });
    const addonTxSum = addonTxs._sum.amount ?? 0;

    if (addonTxSum !== currentAddonBalance) {
      this.logger.error(`[ALARM] User ${userId} addon balance mismatch! DB Balance: ${currentAddonBalance}, TX Sum: ${addonTxSum}`);
    }
  }
}
