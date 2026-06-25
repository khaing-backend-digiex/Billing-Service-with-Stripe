import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { StripeModule } from "./stripe/stripe.module";
import { HealthController } from "./health/health.controller";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";

@Module({
  imports: [
    AppConfigModule,

    DatabaseModule,

    AuthModule,
    UsersModule,
    StripeModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
