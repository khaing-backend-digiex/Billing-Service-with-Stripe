import {
  Controller,
  Post,
  Get,
  Body,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Query,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse as SwaggerResponse,
} from "@nestjs/swagger";
import { PaymentProvider } from "@prisma/client";
import { PaymentsService } from "./payments.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CancelSubscriptionDto } from "./dto/cancel-subscription.dto";
import { UpgradeSubscriptionDto } from "./dto/upgrade-subscription.dto";
import { ApiResponse } from "../common/dto/api-response.dto";
import { GetUser } from "../common/decorators/get-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../database/prisma.service";

@ApiTags("Payments")
@ApiBearerAuth("JWT-auth")
@Controller("payments")
@UseGuards(RolesGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) { }

  @Post("customers")
  async createCustomer(
    @GetUser("id") userId: string,
    @Body() dto: CreateCustomerDto & { provider?: PaymentProvider },
  ) {
    const user = await this.usersService.findById(userId);
    const provider = dto.provider || PaymentProvider.STRIPE;

    if (provider === PaymentProvider.STRIPE && user.providerCustomerId) {
      throw new BadRequestException("User already has a Stripe customer account");
    }

    const customer = await this.paymentsService.createCustomer(
      userId,
      dto.email || user.email,
      dto.name || user.name || undefined,
      provider,
    );

    return new ApiResponse(HttpStatus.CREATED, "Customer created successfully", customer);
  }

  @Post("billing-portal")
  @ApiOperation({ summary: "Create a billing portal session" })
  @SwaggerResponse({
    status: 201,
    description: "Billing portal session created",
  })
  async createBillingPortal(
    @GetUser("id") userId: string,
    @Body() dto: { provider?: PaymentProvider },
  ) {
    const user = await this.usersService.findById(userId);
    const provider = dto?.provider || PaymentProvider.STRIPE;

    if (provider === PaymentProvider.STRIPE && !user.providerCustomerId) {
      throw new BadRequestException("User does not have a Stripe customer account. Create one first.");
    }

    const customerId = user.providerCustomerId || "";
    const session = await this.paymentsService.createBillingPortalSession(
      customerId,
      undefined,
      provider,
    );

    return new ApiResponse(HttpStatus.CREATED, "Billing portal session created successfully", session);
  }

  @Post("cancel-subscription")
  @ApiOperation({ summary: "Cancel subscription at period end" })
  @SwaggerResponse({
    status: 200,
    description: "Subscription will cancel at period end",
  })
  async cancelSubscription(
    @GetUser("id") userId: string,
    @Body() dto: CancelSubscriptionDto & { provider?: PaymentProvider },
  ) {
    const user = await this.usersService.findById(userId);
    const provider = dto.provider || PaymentProvider.STRIPE;

    if (provider === PaymentProvider.STRIPE && !user.providerCustomerId) {
      throw new BadRequestException("User does not have a Stripe customer account.");
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription || !subscription.providerSubscriptionId) {
      throw new BadRequestException("Active subscription not found.");
    }

    await this.paymentsService.cancelSubscriptionAtPeriodEnd(
      subscription.providerSubscriptionId!,
      provider,
    );

    return new ApiResponse(HttpStatus.OK, "Subscription will cancel at period end", null);
  }

  @Post("subscriptions/upgrade-tier")
  @ApiOperation({ summary: "Upgrade subscription tier (same billing cycle, e.g. Pro to Ultra)" })
  @SwaggerResponse({
    status: 200,
    description: "Subscription tier upgraded successfully",
  })
  async upgradeSubscriptionTier(
    @GetUser("id") userId: string,
    @Body() dto: UpgradeSubscriptionDto,
  ) {
    const updatedSub = await this.paymentsService.upgradeSubscriptionTier(
      userId,
      dto.pricingOptionId,
      dto.provider,
    );
    return new ApiResponse(HttpStatus.OK, "Subscription tier upgraded successfully", updatedSub);
  }

  @Post("subscriptions/upgrade-cycle")
  @ApiOperation({ summary: "Upgrade subscription billing cycle (e.g. Monthly to Yearly)" })
  @SwaggerResponse({
    status: 200,
    description: "Subscription billing cycle upgraded successfully",
  })
  async upgradeSubscriptionCycle(
    @GetUser("id") userId: string,
    @Body() dto: UpgradeSubscriptionDto,
  ) {
    const updatedSub = await this.paymentsService.upgradeSubscriptionCycle(
      userId,
      dto.pricingOptionId,
      dto.provider,
    );
    return new ApiResponse(HttpStatus.OK, "Subscription billing cycle upgraded successfully", updatedSub);
  }

  @Get("subscriptions/preview-upgrade-tier")
  @ApiOperation({ summary: "Preview subscription tier upgrade (same billing cycle)" })
  @SwaggerResponse({
    status: 200,
    description: "Returns the upcoming invoice preview for the tier upgrade",
  })
  async previewUpgradeSubscriptionTier(
    @GetUser("id") userId: string,
    @Query("pricingOptionId") pricingOptionId: string,
    @Query("provider") provider?: PaymentProvider,
  ) {
    if (!pricingOptionId) {
      throw new BadRequestException("pricingOptionId is required");
    }
    const preview = await this.paymentsService.previewUpgradeSubscriptionTier(
      userId,
      pricingOptionId,
      provider,
    );
    return new ApiResponse(HttpStatus.OK, "Upcoming invoice preview generated successfully", preview);
  }

  @Get("subscriptions/preview-upgrade-cycle")
  @ApiOperation({ summary: "Preview subscription billing cycle upgrade (e.g. Monthly to Yearly)" })
  @SwaggerResponse({
    status: 200,
    description: "Returns the upcoming invoice preview for the cycle upgrade",
  })
  async previewUpgradeSubscriptionCycle(
    @GetUser("id") userId: string,
    @Query("pricingOptionId") pricingOptionId: string,
    @Query("provider") provider?: PaymentProvider,
  ) {
    if (!pricingOptionId) {
      throw new BadRequestException("pricingOptionId is required");
    }
    const preview = await this.paymentsService.previewUpgradeSubscriptionCycle(
      userId,
      pricingOptionId,
      provider,
    );
    return new ApiResponse(HttpStatus.OK, "Upcoming invoice preview generated successfully", preview);
  }
}
