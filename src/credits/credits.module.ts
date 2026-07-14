import { Module } from '@nestjs/common';
import { CreditService } from './credit.service';
import { CreditRepository } from './credit.repository';
import { CreditsController } from './credits.controller';

@Module({
  controllers: [CreditsController],
  providers: [CreditService, CreditRepository],
  exports: [CreditService],
})
export class CreditsModule {}
