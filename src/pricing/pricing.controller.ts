import { Controller, Post, Body, Get } from "@nestjs/common";
import { PricingService } from "./pricing.service";
import { Public } from "../common/decorators/public.decorator";

@Controller("pricing")
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Public()
  @Post("plans")
  async createPlan(@Body() body: { code: string; name: string; renewalCredits: number; resetIntervalDay: number }) {
    return this.pricingService.createPlan(body);
  }

  @Public()
  @Get("plans")
  async getPlans() {
    return this.pricingService.getPlans();
  }

  @Public()
  @Post("options")
  async createPricingOption(@Body() body: { planId: string; billingCycleId: string; name: string; price: number; currency: string }) {
    return this.pricingService.createPricingOption(body);
  }

  @Public()
  @Post("billing-cycles")
  async createBillingCycle(@Body() body: { name: string; durationDay: number }) {
    return this.pricingService.createBillingCycle(body);
  }

  @Public()
  @Post("addons")
  async createAddonPackage(@Body() body: { code: string; name: string; credits: number; price: number; currency: string }) {
    return this.pricingService.createAddonPackage(body);
  }

  @Public()
  @Get("addons")
  async getAddonPackages() {
    return this.pricingService.getAddonPackages();
  }
}
