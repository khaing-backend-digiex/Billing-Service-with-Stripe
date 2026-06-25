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
import { StripeService } from "./stripe.service";
import { CreateCheckoutDto } from "./dto/create-checkout.dto";
import { CreatePaymentIntentDto } from "./dto/create-payment-intent.dto";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { ApiResponse } from "../common/dto/api-response.dto";
import { GetUser } from "../common/decorators/get-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { UsersService } from "../users/users.service";

@ApiTags("Stripe")
@ApiBearerAuth("JWT-auth")
@Controller("stripe")
@UseGuards(RolesGuard)
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly usersService: UsersService,
  ) {}

  @Post("customers")
  @ApiOperation({ summary: "Create a Stripe customer for the current user" })
  @SwaggerResponse({
    status: 201,
    description: "Customer created successfully",
  })
  async createCustomer(
    @GetUser("id") userId: number,
    @Body() dto: CreateCustomerDto,
  ) {
    const user = await this.usersService.findById(userId);

    if (user.stripeCustomerId) {
      throw new BadRequestException(
        "User already has a Stripe customer account",
      );
    }

    const customer = await this.stripeService.createCustomer(
      userId,
      dto.email || user.email,
      dto.name || user.name,
    );

    return new ApiResponse(
      HttpStatus.CREATED,
      "Stripe customer created successfully",
      {
        customerId: customer.id,
        email: customer.email,
      },
    );
  }

  @Post("checkout")
  @ApiOperation({ summary: "Create a Stripe checkout session" })
  @SwaggerResponse({ status: 201, description: "Checkout session created" })
  async createCheckout(
    @GetUser("id") userId: number,
    @Body() dto: CreateCheckoutDto,
  ) {
    const user = await this.usersService.findById(userId);

    const session = await this.stripeService.createCheckoutSession(
      userId,
      dto.priceId,
      dto.mode,
      user.stripeCustomerId || undefined,
    );

    return new ApiResponse(
      HttpStatus.CREATED,
      "Checkout session created successfully",
      {
        sessionId: session.id,
        url: session.url,
      },
    );
  }

  @Post("payment-intent")
  @ApiOperation({ summary: "Create a payment intent" })
  @SwaggerResponse({ status: 201, description: "Payment intent created" })
  async createPaymentIntent(
    @GetUser("id") userId: number,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    const user = await this.usersService.findById(userId);

    const paymentIntent = await this.stripeService.createPaymentIntent(
      userId,
      dto.amount,
      dto.currency,
      dto.description,
      user.stripeCustomerId || undefined,
    );

    return new ApiResponse(
      HttpStatus.CREATED,
      "Payment intent created successfully",
      {
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      },
    );
  }

  @Post("billing-portal")
  @ApiOperation({ summary: "Create a billing portal session" })
  @SwaggerResponse({
    status: 201,
    description: "Billing portal session created",
  })
  async createBillingPortal(@GetUser("id") userId: number) {
    const user = await this.usersService.findById(userId);

    if (!user.stripeCustomerId) {
      throw new BadRequestException(
        "User does not have a Stripe customer account. Create one first.",
      );
    }

    const session = await this.stripeService.createBillingPortalSession(
      user.stripeCustomerId,
    );

    return new ApiResponse(
      HttpStatus.CREATED,
      "Billing portal session created successfully",
      {
        url: session.url,
      },
    );
  }

  @Get("payments")
  @ApiOperation({ summary: "Get payment history for the current user" })
  async getPayments(@GetUser("id") userId: number) {
    const payments = await this.stripeService.getPaymentsByUserId(userId);
    return new ApiResponse(
      HttpStatus.OK,
      "Payments fetched successfully",
      payments,
    );
  }
}
