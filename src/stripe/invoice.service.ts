import { Injectable, Logger } from "@nestjs/common";
import { Invoice, InvoiceStatus, PaymentProvider, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { PaymentInvoice } from "../payments/types/payment.types";
import { formatStripeAmountToDatabase } from "./utils/stripe-currency.util";

/**
 * Chủ sở hữu bảng `Invoice`. Mọi thay đổi trạng thái hoá đơn đi qua đây.
 *
 * Nhận `tx` thay vì tự mở transaction: bên gọi (settlement, strategy) mới là nơi quyết định
 * ranh giới atomic. Cùng quy ước với phương án (a) trong docs/credits-refactor.md §6 —
 * `tx` là ngữ cảnh, không phải quyền.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  /** Tìm hoặc tạo hàng local. Luôn tạo ở OPEN – chuyển sang PAID/UNCOLLECTIBLE là việc của bên gọi. */
  async ensureLocal(
    providerInvoice: PaymentInvoice,
    subscriptionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Invoice> {
    return this.db(tx).invoice.upsert({
      where: { providerInvoiceId: providerInvoice.id },
      update: {},
      create: this.createData(providerInvoice, subscriptionId),
    });
  }

  /**
   * Chốt chặn idempotency của toàn bộ luồng settlement.
   *
   * Compare-and-swap: chỉ đúng một lời gọi thắng, kể cả khi webhook và reconciliation cron
   * chạm cùng một hoá đơn cùng lúc. Trả về boolean để bên gọi KHÔNG THỂ quên kiểm tra –
   * trước đây đây là một quy ước nằm trong thân hàm, ai viết caller mới cũng có thể bỏ sót.
   */
  async claimAsPaid(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    billingReason: string | null,
  ): Promise<boolean> {
    const claimed = await tx.invoice.updateMany({
      where: { id: invoiceId, status: { not: InvoiceStatus.PAID } },
      data: {
        status: InvoiceStatus.PAID,
        billingReason,
        paidAt: new Date(),
      },
    });

    return claimed.count > 0;
  }

  /**
   * Ghi nhận một lần thu tiền hỏng: giữ hoá đơn ở OPEN và cập nhật bộ đếm retry của Stripe.
   *
   * `subscriptionId = null` nghĩa là không tra ra subscription local → chỉ cập nhật được
   * hoá đơn đã tồn tại. Trả `null` nếu nó cũng không tồn tại, thay vì ném P2025 rồi làm
   * chết cả event như trước.
   */
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
      return tx.invoice.upsert({
        where: { providerInvoiceId: providerInvoice.id },
        update: retryData,
        create: { ...this.createData(providerInvoice, subscriptionId), ...retryData },
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

  /**
   * Subscription local này đã từng có hoá đơn nào được trả chưa (không tính hoá đơn đang xử lý)?
   *
   * Dùng để phân biệt "subscription mới" với "sub free sinh ra do downgrade": Stripe gắn
   * `billing_reason = subscription_create` cho hoá đơn đầu của CẢ HAI, nên nhãn của Stripe
   * không kết luận được. Dữ liệu thì kết luận được.
   */
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

  /** Stripe đã bỏ cuộc: không retry nữa. */
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
