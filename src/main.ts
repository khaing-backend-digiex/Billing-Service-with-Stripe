import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/exceptions/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>("PORT", 3000);
  const logger = new Logger("Bootstrap");

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("NestJS Stripe Boilerplate")
    .setDescription(
      "A production-ready NestJS starter with Stripe integration, JWT authentication, and role-based access control.",
    )
    .setVersion("1.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        name: "Authorization",
        description: "Enter your JWT token",
        in: "header",
      },
      "JWT-auth",
    )
    .addTag("Auth", "Authentication endpoints (login, register)")
    .addTag("Users", "User management endpoints")
    .addTag("Stripe", "Stripe payment endpoints")
    .addTag("Stripe Webhooks", "Stripe webhook handler")
    .addTag("Health", "Health check endpoint")
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  await app.listen(port);
  logger.log(`🚀 Server is running on http://localhost:${port}`);
  logger.log(`📚 Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
