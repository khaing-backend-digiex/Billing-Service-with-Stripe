import { BadRequestException } from '@nestjs/common';

export class InsufficientCreditsException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsException';
  }
}
