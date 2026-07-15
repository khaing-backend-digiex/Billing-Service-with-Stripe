import { Controller, Post, Body, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PricingService } from "./pricing.service";
import { Public } from "../common/decorators/public.decorator";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { CreatePricingOptionDto } from "./dto/create-pricing-option.dto";
import { CreateBillingCycleDto } from "./dto/create-billing-cycle.dto";
import { CreateAddonPackageDto } from "./dto/create-addon-package.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { Roles } from "../common/decorators/roles.decorator";
import { Role } from "../common/constants/roles.enum";

@ApiTags("Pricing")
@UseGuards(RolesGuard)
@Controller("pricing")
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  
  @Post("plans")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Create a new plan" })
  async createPlan(@Body() body: CreatePlanDto) {
    return this.pricingService.createPlan(body);
  }

  @Public()
  @Get("plans")
  @ApiOperation({ summary: "Get all plans" })
  async getPlans() {
    return this.pricingService.getPlans();
  }

  
  @Post("options")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Create a new pricing option" })
  async createPricingOption(@Body() body: CreatePricingOptionDto) {
    return this.pricingService.createPricingOption(body);
  }

  
  @Post("billing-cycles")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Create a new billing cycle" })
  async createBillingCycle(@Body() body: CreateBillingCycleDto) {
    return this.pricingService.createBillingCycle(body);
  }

  
  @Post("addons")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Create a new addon package" })
  async createAddonPackage(@Body() body: CreateAddonPackageDto) {
    return this.pricingService.createAddonPackage(body);
  }

  @Public()
  @Get("addons")
  @ApiOperation({ summary: "Get all addon packages" })
  async getAddonPackages() {
    return this.pricingService.getAddonPackages();
  }
}
