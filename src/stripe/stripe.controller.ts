import {
  Controller,
  Post,
  Get,
  Body,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Header,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse as SwaggerResponse,
} from "@nestjs/swagger";
import { StripeService } from "./stripe.service";
import { CreateSubscriptionCheckoutDto, CreateAddonCheckoutDto } from "../payments/dto/create-checkout.dto";
import { CreatePaymentIntentDto } from "../payments/dto/create-payment-intent.dto";
import { CreateCustomerDto } from "../payments/dto/create-customer.dto";
import { ApiResponse } from "../common/dto/api-response.dto";
import { GetUser } from "../common/decorators/get-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../database/prisma.service";
import { SubscriptionStatus } from "@prisma/client";
import { PLAN_CODES } from "../common/constants/plan.constants";
import { Roles } from "../common/decorators/roles.decorator";
import { Role } from "../common/constants/roles.enum";
import { Public } from "../common/decorators/public.decorator";

@ApiTags("Stripe")
@ApiBearerAuth("JWT-auth")
@Controller("stripe")
@UseGuards(RolesGuard)
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) { }

  @Post("customers")
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Create a Stripe customer for the current user" })
  async createCustomer(
    @GetUser("id") userId: string,
    @Body() dto: CreateCustomerDto,
  ) {
    const user = await this.usersService.findById(userId);

    if (user.providerCustomerId) {
      throw new BadRequestException("User already has a Stripe customer account");
    }

    const customerId = await this.stripeService.ensureCustomerId({
      id: user.id,
      email: dto.email || user.email,
      name: dto.name || user.name || undefined,
      providerCustomerId: user.providerCustomerId || undefined,
    });

    return new ApiResponse(HttpStatus.CREATED, "Stripe customer created", {
      customerId,
      email: dto.email || user.email,
    });
  }

  @Post("checkout/subscription")
  @ApiOperation({ summary: "Create a Stripe checkout session for a subscription" })
  async createSubscriptionCheckout(
    @GetUser("id") userId: string,
    @Body() dto: CreateSubscriptionCheckoutDto,
  ) {
    const user = await this.usersService.findById(userId);
    const currentSubscription = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { pricingOption: true },
    });

    if (currentSubscription && currentSubscription.pricingOption) {
      const isCancelledOrExpired =
        currentSubscription.status === SubscriptionStatus.CANCELLED ||
        currentSubscription.status === SubscriptionStatus.EXPIRED;

      if (!isCancelledOrExpired) {
        const price = Number(currentSubscription.pricingOption.price);
        if (price > 0) {
          throw new BadRequestException("Cannot create a new subscription checkout session while an active paid subscription exists. Please cancel your current subscription first.");
        }
      }
    }

    // Validate that the pricingOptionId belongs to a valid Subscription Pricing Option
    const pricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: dto.pricingOptionId },
    });

    if (!pricingOption || !pricingOption.providerPriceId) {
      throw new BadRequestException("Pricing option not found or it does not have a valid Stripe Price ID");
    }

    let providerCustomerId = user.providerCustomerId;

    if (!providerCustomerId) {
      providerCustomerId = await this.stripeService.ensureCustomerId(user);
    }

    const session = await this.stripeService.createCheckoutSession(
      userId,
      pricingOption.providerPriceId,
      "subscription",
      providerCustomerId,
    );

    return new ApiResponse(HttpStatus.CREATED, "Subscription checkout session created", {
      url: session.url,
    });
  }

  @Post("checkout/addon")
  @ApiOperation({ summary: "Create a Stripe checkout session for an addon" })
  async createAddonCheckout(
    @GetUser("id") userId: string,
    @Body() dto: CreateAddonCheckoutDto,
  ) {
    const user = await this.usersService.findById(userId);

    const currentSubscription = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { pricingOption: { include: { plan: true } } },
    });

    const isPaidPlanActive =
      currentSubscription &&
      currentSubscription.status === SubscriptionStatus.ACTIVE &&
      currentSubscription.pricingOption?.plan?.code !== PLAN_CODES.FREE;

    if (!isPaidPlanActive) {
      throw new BadRequestException("You must have an active paid subscription to purchase addons.");
    }

    const addon = await this.prisma.addonPackage.findUnique({
      where: { id: dto.addonPackageId },
    });

    if (!addon || !addon.providerPriceId) {
      throw new BadRequestException("Addon package not found or it does not have a valid Stripe Price ID");
    }

    const session = await this.stripeService.createCheckoutSession(
      userId,
      addon.providerPriceId,
      "payment",
      user.providerCustomerId || undefined,
      { addonPackageId: addon.id }
    );

    return new ApiResponse(HttpStatus.CREATED, "Addon checkout session created", {
      url: session.url,
    });
  }

  @Post("payment-intent")
  @ApiOperation({ summary: "Create a payment intent" })
  async createPaymentIntent(
    @GetUser("id") userId: string,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    const user = await this.usersService.findById(userId);

    const paymentIntent = await this.stripeService.createPaymentIntent(
      userId,
      dto.amount,
      dto.currency,
      dto.description,
      user.providerCustomerId || undefined,
    );

    return new ApiResponse(HttpStatus.CREATED, "Payment intent created", {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.clientSecret,
    });
  }

  @Post("billing-portal")
  @ApiOperation({ summary: "Create a billing portal session" })
  async createBillingPortal(@GetUser("id") userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user.providerCustomerId) {
      throw new BadRequestException("User does not have a Stripe customer account.");
    }

    const session = await this.stripeService.createBillingPortalSession(
      user.providerCustomerId,
    );

    return new ApiResponse(HttpStatus.CREATED, "Billing portal session created", {
      url: session.url,
    });
  }

  @Get("payments")
  @ApiOperation({ summary: "Get payment history for the current user" })
  async getPayments(@GetUser("id") userId: string) {
    const payments = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return new ApiResponse(HttpStatus.OK, "Payments fetched successfully", payments);
  }
}
