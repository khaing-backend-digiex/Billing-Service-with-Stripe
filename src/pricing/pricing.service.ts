import { Injectable, InternalServerErrorException, Inject } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { ConfigService } from "@nestjs/config";
import {PaymentProvider} from "@prisma/client"
import { formatDatabaseAmountToStripe } from "../stripe/utils/stripe-currency.util";
import { IPaymentAdapter } from "../payments/types/payment-adapter.interface";

const INTERVAL = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
} as const;

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject("PAYMENT_ADAPTER")
    private readonly adapter: IPaymentAdapter,
  ) {}

  async createPlan(data: { 
    productId: string; 
    code: string; 
    name: string; 
    isFree?: boolean; 
    creditAmount: number; 
    resetInterval: 'MONTHLY' | 'EVERY_N_DAYS'; 
    intervalDays?: number 
  }) {
    return this.prisma.plan.create({ 
      data: {
        productId: data.productId,
        code: data.code,
        name: data.name,
        isFree: data.isFree,
        creditPolicy: {
          create: {
            creditAmount: data.creditAmount,
            resetInterval: data.resetInterval,
            intervalDays: data.intervalDays,
          }
        }
      } 
    });
  }

  async getPlans() {
    return this.prisma.plan.findMany({ include: { pricingOptions: true } });
  }

  async createBillingCycle(data: { name: string; durationDay: number }) {
    return this.prisma.billingCycle.create({ data });
  }

  async createPricingOption(data: { planId: string; productId: string; billingCycleId: string; name: string; price: number; currency: string }) {
    try {
      const plan = await this.prisma.plan.findUnique({ where: { id: data.planId } });
      if (!plan) throw new Error("Plan not found");

      const billingCycle = await this.prisma.billingCycle.findUnique({ where: { id: data.billingCycleId } });
      if (!billingCycle) throw new Error("Billing cycle not found");

      let interval: 'day' | 'week' | 'month' | 'year' = INTERVAL.DAY;
      let intervalCount = billingCycle.durationDay;

      if (billingCycle.durationDay === 365 || billingCycle.durationDay === 366) {
        interval = INTERVAL.YEAR;
        intervalCount = 1;
      } else if (billingCycle.durationDay % 30 === 0) {
        interval = INTERVAL.MONTH;
        intervalCount = billingCycle.durationDay / 30;
      } else if (billingCycle.durationDay % 7 === 0) {
        interval = INTERVAL.WEEK;
        intervalCount = billingCycle.durationDay / 7;
      }

      const productId = await this.adapter.createProduct(`${plan.name} - ${billingCycle.name}`);

      const priceId = await this.adapter.createRecurringPrice(
        productId,
        formatDatabaseAmountToStripe(data.price, data.currency),
        data.currency,
        { interval, intervalCount }
      );

      return await this.prisma.pricingOption.create({
        data: {
          planId: data.planId,
          productId: data.productId,
          billingCycleId: data.billingCycleId,
          name: data.name,
          price: data.price,
          currency: data.currency,
          provider: PaymentProvider.STRIPE,
          providerPriceId: priceId,
        },
      });
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException("Failed to create pricing option with Stripe");
    }
  }

  async findByProviderPriceId(priceId: string) {
    return this.prisma.pricingOption.findFirst({
      where: { providerPriceId: priceId },
      include: { plan: { include: { creditPolicy: true } } },
    });
  }

  async createAddonPackage(data: { code: string; name: string; credits: number; price: number; currency: string }) {
    try {
      const productId = await this.adapter.createProduct(data.name);

      const priceId = await this.adapter.createOneTimePrice(
        productId,
        formatDatabaseAmountToStripe(data.price, data.currency),
        data.currency
      );

      return await this.prisma.addonPackage.create({
        data: {
          code: data.code,
          name: data.name,
          credits: data.credits,
          price: data.price,
          currency: data.currency,
          provider: PaymentProvider.STRIPE,
          providerPriceId: priceId,
        },
      });
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException("Failed to create addon package with Stripe");
    }
  }

  async getAddonPackages() {
    return this.prisma.addonPackage.findMany();
  }

  async findAddonByProviderPriceId(priceId: string) {
    return this.prisma.addonPackage.findFirst({
      where: { providerPriceId: priceId },
    });
  }
}
