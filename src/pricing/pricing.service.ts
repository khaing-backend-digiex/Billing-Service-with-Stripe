import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import Stripe from "stripe";
import { ConfigService } from "@nestjs/config";
import { formatDatabaseAmountToStripe } from "../stripe/utils/stripe-currency.util";

@Injectable()
export class PricingService {
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.stripe = new Stripe(this.configService.get<string>("STRIPE_SECRET_KEY") || "");
  }

  async createPlan(data: { code: string; name: string; renewalCredits: number; resetIntervalDay: number }) {
    return this.prisma.plan.create({ data });
  }

  async getPlans() {
    return this.prisma.plan.findMany({ include: { pricingOptions: true } });
  }

  async createBillingCycle(data: { name: string; durationDay: number }) {
    return this.prisma.billingCycle.create({ data });
  }

  async createPricingOption(data: { planId: string; billingCycleId: string; name: string; price: number; currency: string }) {
    try {
      const plan = await this.prisma.plan.findUnique({ where: { id: data.planId } });
      if (!plan) throw new Error("Plan not found");

      const billingCycle = await this.prisma.billingCycle.findUnique({ where: { id: data.billingCycleId } });
      if (!billingCycle) throw new Error("Billing cycle not found");

      let interval: Stripe.PriceCreateParams.Recurring.Interval = "day";
      let intervalCount = billingCycle.durationDay;

      if (billingCycle.durationDay === 365 || billingCycle.durationDay === 366) {
        interval = "year";
        intervalCount = 1;
      } else if (billingCycle.durationDay % 30 === 0) {
        interval = "month";
        intervalCount = billingCycle.durationDay / 30;
      } else if (billingCycle.durationDay % 7 === 0) {
        interval = "week";
        intervalCount = billingCycle.durationDay / 7;
      }

      const product = await this.stripe.products.create({
        name: `${plan.name} - ${billingCycle.name}`,
      });

      const price = await this.stripe.prices.create({
        product: product.id,
        unit_amount: formatDatabaseAmountToStripe(data.price, data.currency),
        currency: data.currency,
        recurring: { 
          interval: interval,
          interval_count: intervalCount
        }, 
      });

      return this.prisma.pricingOption.create({
        data: {
          planId: data.planId,
          billingCycleId: data.billingCycleId,
          name: data.name,
          price: data.price,
          currency: data.currency,
          provider: "STRIPE",
          providerPriceId: price.id,
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
      include: { plan: true },
    });
  }

  async createAddonPackage(data: { code: string; name: string; credits: number; price: number; currency: string }) {
    try {
      const product = await this.stripe.products.create({
        name: data.name,
      });

      const price = await this.stripe.prices.create({
        product: product.id,
        unit_amount: formatDatabaseAmountToStripe(data.price, data.currency),
        currency: data.currency,
      });

      return this.prisma.addonPackage.create({
        data: {
          code: data.code,
          name: data.name,
          credits: data.credits,
          price: data.price,
          currency: data.currency,
          provider: "STRIPE",
          providerPriceId: price.id,
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
