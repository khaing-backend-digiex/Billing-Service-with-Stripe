import {
  Controller,
  Post,
  Get,
  Body,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { StripeService } from "./stripe.service";
import { PaymentMethodSyncService } from "./sync/payment-method-sync.service";
import { PurchaseSubscriptionDto, PurchaseAddonDto } from "../payments/dto/purchase.dto";
import { CreateCustomerDto } from "../payments/dto/create-customer.dto";
import { ApiResponse } from "../common/dto/api-response.dto";
import { GetUser } from "../common/decorators/get-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../database/prisma.service";
import { SubscriptionStatus, InvoiceStatus } from "@prisma/client";
import { PLAN_CODES } from "../common/constants/plan.constants";
import { Roles } from "../common/decorators/roles.decorator";
import { Role } from "../common/constants/roles.enum";

const BLOCKING_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
];

@ApiTags("Stripe")
@ApiBearerAuth("JWT-auth")
@Controller("stripe")
@UseGuards(RolesGuard)
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly paymentMethodSync: PaymentMethodSyncService,
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
  @ApiOperation({ summary: "Buy a subscription with the saved default card" })
  async purchaseSubscription(
    @GetUser("id") userId: string,
    @Body() dto: PurchaseSubscriptionDto,
  ) {
    const user = await this.usersService.findById(userId);
    const currentSubscription = await this.prisma.subscription.findFirst({
      where: { 
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.TRIALING] }
      },
      include: { pricingOption: true },
    });

    const badDebtInvoice = await this.prisma.invoice.findFirst({
      where: {
        subscription: { userId },
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.UNCOLLECTIBLE] },
      },
    });

    if (badDebtInvoice) {
      throw new BadRequestException("You have an unpaid invoice. Please pay it before creating a new subscription.");
    }

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

    const pricingOption = await this.prisma.pricingOption.findUnique({
      where: { id: dto.pricingOptionId },
    });

    if (!pricingOption || !pricingOption.providerPriceId) {
      throw new BadRequestException("Pricing option not found or it does not have a valid Stripe Price ID");
    }

    const customerId = await this.stripeService.ensureValidCustomerId(user);
    const paymentMethod = await this.paymentMethodSync.getDefaultOrThrow(userId, customerId);

    const result = await this.stripeService.createOffSessionSubscription(
      userId,
      pricingOption.providerPriceId,
      customerId,
      paymentMethod.providerPaymentMethodId,
    );

    return new ApiResponse(HttpStatus.CREATED, "Subscription purchase started", {
      subscriptionId: result.subscription.id,
      status: result.status,
      clientSecret: result.clientSecret,
    });
  }

  @Post("checkout/addon")
  @ApiOperation({ summary: "Buy an addon with the saved default card" })
  async purchaseAddon(
    @GetUser("id") userId: string,
    @Body() dto: PurchaseAddonDto,
  ) {
    const user = await this.usersService.findById(userId);

    const currentSubscription = await this.prisma.subscription.findFirst({
      where: { 
        userId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.TRIALING] }
      },
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

    if (!addon) {
      throw new BadRequestException("Addon package not found");
    }

    const customerId = await this.stripeService.ensureValidCustomerId(user);
    const paymentMethod = await this.paymentMethodSync.getDefaultOrThrow(userId, customerId);

    const result = await this.stripeService.createAddonPayment(
      userId,
      addon,
      customerId,
      paymentMethod.providerPaymentMethodId,
    );

    return new ApiResponse(HttpStatus.CREATED, "Addon purchase started", {
      paymentIntentId: result.paymentIntentId,
      status: result.status,
      clientSecret: result.clientSecret,
    });
  }

  @Post("billing-portal")
  @ApiOperation({ summary: "Create a billing portal session (invoice history only – cards are managed in-app)" })
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
