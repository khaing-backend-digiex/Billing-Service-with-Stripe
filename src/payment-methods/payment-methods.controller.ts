import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { PaymentMethodsService } from "./payment-methods.service";
import { ApiResponse } from "../common/dto/api-response.dto";
import { GetUser } from "../common/decorators/get-user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";

@ApiTags("Payment Methods")
@ApiBearerAuth("JWT-auth")
@Controller("payment-methods")
@UseGuards(RolesGuard)
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post("setup-intent")
  @ApiOperation({ summary: "Start saving a card (returns a SetupIntent client secret)" })
  async createSetupIntent(@GetUser("id") userId: number) {
    const setupIntent = await this.paymentMethodsService.createSetupIntent(userId);

    return new ApiResponse(HttpStatus.CREATED, "Setup intent created", {
      setupIntentId: setupIntent.id,
      clientSecret: setupIntent.clientSecret,
    });
  }

  @Get()
  @ApiOperation({ summary: "List the saved cards of the current user" })
  async list(@GetUser("id") userId: number) {
    const paymentMethods = await this.paymentMethodsService.list(userId);

    return new ApiResponse(HttpStatus.OK, "Payment methods fetched successfully", paymentMethods);
  }

  @Post(":id/default")
  @ApiOperation({ summary: "Set a saved card as the default one" })
  async setDefault(@GetUser("id") userId: number, @Param("id") id: string) {
    await this.paymentMethodsService.setDefault(userId, id);

    return new ApiResponse(HttpStatus.OK, "Default payment method updated", null);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a saved card" })
  async remove(@GetUser("id") userId: number, @Param("id") id: string) {
    await this.paymentMethodsService.remove(userId, id);

    return new ApiResponse(HttpStatus.OK, "Payment method removed", null);
  }
}
