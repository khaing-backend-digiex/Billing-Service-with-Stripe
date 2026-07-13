import { Controller, Post, Body, HttpCode, HttpStatus, UsePipes, ValidationPipe, Get, Req, UseGuards } from '@nestjs/common';
import { CreditService } from './credit.service';
import { ConsumeCreditsDto } from './dto/consume-credits.dto';
import { creditKey } from './credit.types';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ApiResponse } from '../common/dto/api-response.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiBearerAuth("JWT-auth")
@UseGuards(JwtAuthGuard)
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditService: CreditService) {}

  @Post('consume')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true }))
  async consumeCredits(@Req() req: any, @Body() dto: ConsumeCreditsDto) {
    const result = await this.creditService.consume({
      userId: req.user.id,
      amount: dto.amount,
      referenceId: dto.referenceId ?? 'api-consume',
      description: dto.description ?? 'API Consume',
      idempotencyKey: creditKey.consume(req.user.id, dto.idempotencyKey),
    });

    return new ApiResponse(
      HttpStatus.OK,
      'Credits consumed successfully',
      result,
    );
  }

  @Get('status')
  async getUserStatus(@Req() req: any) {
    const userId = req.user.id;
    const status = await this.creditService.getUserPackageStatus(userId);
    return new ApiResponse(
      HttpStatus.OK,
      'User package status retrieved successfully',
      status,
    );
  }
}
