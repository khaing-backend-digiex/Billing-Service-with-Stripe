import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { User } from "./entities/user.entity";
import { Payment } from "./entities/payment.entity";
import { PrismaService } from "./prisma.service";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",

        url: configService.get<string>("DATABASE_URL"),

        ssl: {
          rejectUnauthorized: false,
        },
        entities: [User, Payment],

        synchronize:
          configService.get<string>("DB_SYNCHRONIZE", "false") === "true",

        logging: false,
      }),
    }),
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule { }