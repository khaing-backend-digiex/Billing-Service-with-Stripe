import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../database/prisma.service";
import { StripeService } from "../stripe/stripe.service";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

@Injectable()
export class CleanupTaskCron {
  private readonly logger = new Logger(CleanupTaskCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processPending(): Promise<void> {
    const tasks = await this.prisma.cleanupTask.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (tasks.length === 0) return;
    this.logger.log(`Cleanup queue: processing ${tasks.length} task(s)`);

    for (const task of tasks) {
      try {
        await this.stripeService.deleteCustomer(task.target);
        await this.prisma.cleanupTask.update({
          where: { id: task.id },
          data: { status: "DONE" },
        });
        this.logger.log(`✅ Cleaned up Stripe customer ${task.target}`);
      } catch (error) {
        const attempts = task.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
        await this.prisma.cleanupTask.update({
          where: { id: task.id },
          data: { attempts, status, lastError: String(error) },
        });
        this.logger.error(
          `Cleanup failed for ${task.target} (attempt ${attempts}/${MAX_ATTEMPTS}, status=${status}): ${error}`,
        );
      }
    }
  }
}
