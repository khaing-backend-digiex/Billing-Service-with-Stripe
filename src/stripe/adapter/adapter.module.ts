import { Global, Module } from "@nestjs/common";
import { StripeAdapter } from "./stripe.adapter";

@Global()
@Module({
  providers: [
    {
      provide: "PAYMENT_ADAPTER",
      useClass: StripeAdapter,
    },
  ],
  exports: ["PAYMENT_ADAPTER"],
})
export class PaymentAdapterModule {}
