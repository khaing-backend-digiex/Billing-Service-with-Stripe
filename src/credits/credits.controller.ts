import { Controller, Post, Body, HttpCode, HttpStatus, UsePipes, ValidationPipe, Get, Req, UseGuards, Query } from '@nestjs/common';
import { CreditService } from './credit.service';
import { ConsumeCreditsDto } from './dto/consume-credits.dto';
import { creditKey } from './credit.types';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { ApiResponse } from '../common/dto/api-response.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

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
      productId: dto.productId,
      amount: dto.amount,
      referenceId: dto.referenceId ?? 'api-consume',
      description: dto.description ?? 'API Consume',
      idempotencyKey: creditKey.consume(req.user.id, dto.productId, dto.idempotencyKey),
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

  @Get('transactions')
  async getTransactions(
    @Req() req: any,
    @Query() query: PaginationQueryDto
  ) {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const result = await this.creditService.getTransactionHistory(userId, skip, limit);
    return new ApiResponse(
      HttpStatus.OK,
      'Transactions retrieved successfully',
      result,
    );
  }
}
