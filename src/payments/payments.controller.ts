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
  ApiResponse as SwaggerResponse,
} from "@nestjs/swagger";
import { PaymentProvider } from "@prisma/client";
import { PaymentsService } from "./payments.service";
import { CreateCheckoutDto } from "../payments/dto/create-checkout.dto";
import { CreatePaymentIntentDto } from "./dto/create-payment-intent.dto";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CancelSubscriptionDto } from "./dto/cancel-subscription.dto";
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
    @GetUser("id") userId: number,
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

  @Post("checkout")
  async createCheckout(
    @GetUser("id") userId: number,
    @Body() dto: CreateCheckoutDto & { provider?: PaymentProvider },
  ) {
    const user = await this.usersService.findById(userId);
    const provider = dto.provider || PaymentProvider.STRIPE;

    const session = await this.paymentsService.createCheckoutSession(
      userId,
      dto.priceId,
      dto.mode,
      provider === PaymentProvider.STRIPE ? user.providerCustomerId || undefined : undefined,
      provider,
    );

    return new ApiResponse(HttpStatus.CREATED, "Checkout session created successfully", session);
  }

  @Post("payment-intent")
  @ApiOperation({ summary: "Create a payment intent" })
  @SwaggerResponse({ status: 201, description: "Payment intent created" })
  async createPaymentIntent(
    @GetUser("id") userId: number,
    @Body() dto: CreatePaymentIntentDto & { provider?: PaymentProvider },
  ) {
    const user = await this.usersService.findById(userId);
    const provider = dto.provider || PaymentProvider.STRIPE;

    const paymentIntent = await this.paymentsService.createPaymentIntent(
      userId,
      dto.amount,
      dto.currency,
      dto.description,
      provider === PaymentProvider.STRIPE ? user.providerCustomerId || undefined : undefined,
      provider,
    );

    return new ApiResponse(HttpStatus.CREATED, "Payment intent created successfully", paymentIntent);
  }

  @Post("billing-portal")
  @ApiOperation({ summary: "Create a billing portal session" })
  @SwaggerResponse({
    status: 201,
    description: "Billing portal session created",
  })
  async createBillingPortal(
    @GetUser("id") userId: number,
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
    @GetUser("id") userId: number,
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
}
