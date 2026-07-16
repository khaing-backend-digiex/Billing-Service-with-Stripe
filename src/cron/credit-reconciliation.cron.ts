import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class CreditReconciliationCron {
  private readonly logger = new Logger(CreditReconciliationCron.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async run() {
    this.logger.log('Starting daily credit reconciliation check...');
    
    // Get all grants
    const grants = await this.prisma.creditGrant.findMany({
      select: { id: true, userId: true, amountRemaining: true }
    });

    for (const grant of grants) {
      await this.reconcileGrant(grant.id, grant.userId, grant.amountRemaining);
    }
    
    this.logger.log('Finished daily credit reconciliation check.');
  }

  private async reconcileGrant(grantId: string, userId: string, amountRemaining: number) {
    if (amountRemaining < 0) {
      this.logger.error(`[ALARM] User ${userId} has negative balance on grant ${grantId}: ${amountRemaining}`);
    }

    const txs = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { grantId }
    });
    
    const txSum = txs._sum.amount ?? 0;

    if (txSum !== amountRemaining) {
      this.logger.error(`[ALARM] User ${userId} grant ${grantId} balance mismatch! DB Balance: ${amountRemaining}, TX Sum: ${txSum}`);
    }
  }
}
