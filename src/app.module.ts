import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { StripeModule } from "./stripe/stripe.module";
import { PaymentsModule } from "./payments/payments.module";
import { HealthController } from "./health/health.controller";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { PricingModule } from "./pricing/pricing.module";
import { CronModule } from "./cron/cron.module";
import { ProvisioningModule } from "./provisioning/provisioning.module";
import { PaymentAdapterModule } from "./stripe/adapter/adapter.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PaymentAdapterModule,
    DatabaseModule,
    UsersModule,
    AuthModule,
    StripeModule,
    PaymentsModule,
    PricingModule,
    CronModule,
    ProvisioningModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule { }

