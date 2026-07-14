import { Injectable, Logger } from "@nestjs/common";
import { Payment, PaymentProvider, PaymentStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";
import { formatStripeAmountToDatabase } from "./utils/stripe-currency.util";

/**
 * Số tiền LUÔN nhận ở đơn vị nhỏ nhất của provider (cents), không phải đơn vị của DB.
 * Quy đổi nằm trong service này – trước đây mỗi caller tự quy đổi, và `POST /stripe/payment-intent`
 * quên làm, ghi thẳng cents vào DB khiến `GET /stripe/payments` trộn lẫn hai đơn vị.
 */
export interface RecordPaymentInput {
  userId: string;
  providerPaymentId: string;
  providerAmount: number;
  currency: string;
  invoiceId?: string | null;
  addonPackageId?: string | null;
}

/**
 * Chủ sở hữu bảng `Payment`.
 *
 * Bất biến quan trọng nhất: **không bao giờ hạ một khoản đã SUCCEEDED xuống FAILED**.
 * Stripe có thể gửi event thất bại của lần thử trước ĐẾN SAU khi lần thử sau đã thành công.
 * Trước đây bất biến này chỉ tồn tại trong 1 trên 3 nơi ghi bảng.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Prisma.TransactionClient) {
    return tx ?? this.prisma;
  }

  /** Chốt chặn cấp credit addon hai lần khi Stripe gửi lại event. */
  async isSucceeded(
    providerPaymentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const existing = await this.db(tx).payment.findUnique({
      where: { providerPaymentId },
      select: { status: true },
    });

    return existing?.status === PaymentStatus.SUCCEEDED;
  }

  async recordSucceeded(
    input: RecordPaymentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment> {
    return this.db(tx).payment.upsert({
      where: { providerPaymentId: input.providerPaymentId },
      create: {
        ...this.createData(input),
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
      update: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
    });
  }

  /**
   * Chuyển một hàng ĐÃ TỒN TẠI sang FAILED.
   *
   * Trả về hàng đó nếu có (kể cả khi bỏ qua vì đã SUCCEEDED), `null` nếu chưa có hàng nào –
   * caller dùng `null` để biết có cần tạo mới hay không.
   */
  async markFailed(
    providerPaymentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment | null> {
    const db = this.db(tx);
    const existing = await db.payment.findUnique({
      where: { providerPaymentId },
    });

    if (!existing) return null;

    if (existing.status === PaymentStatus.SUCCEEDED) {
      this.logger.log(
        `Payment ${providerPaymentId} already SUCCEEDED – ignoring failure event`,
      );
      return existing;
    }

    return db.payment.update({
      where: { providerPaymentId },
      data: { status: PaymentStatus.FAILED },
    });
  }

  /** Khoản thu hỏng ngay lần đầu (addon off-session bị từ chối) – chưa từng có hàng local. */
  async recordFailed(
    input: RecordPaymentInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Payment> {
    return this.db(tx).payment.create({
      data: { ...this.createData(input), status: PaymentStatus.FAILED },
    });
  }

  private createData(
    input: RecordPaymentInput,
  ): Omit<Prisma.PaymentUncheckedCreateInput, "status"> {
    return {
      userId: input.userId,
      providerPaymentId: input.providerPaymentId,
      provider: PaymentProvider.STRIPE,
      amount: formatStripeAmountToDatabase(input.providerAmount, input.currency),
      currency: input.currency,
      invoiceId: input.invoiceId ?? null,
      addonPackageId: input.addonPackageId ?? null,
    };
  }
}
