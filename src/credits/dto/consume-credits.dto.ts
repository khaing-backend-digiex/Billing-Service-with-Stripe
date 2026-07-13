import { IsNotEmpty, IsNumber, IsString, IsOptional, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class ConsumeCreditsDto {

  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value, 10))
  amount!: number;

  @IsOptional()
  @IsString()
  referenceId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * BẮT BUỘC. Chỉ client mới biết hai lần gọi có phải cùng một request hay không (retry sau
   * timeout, double-click, job chạy lại). Nếu server tự sinh khoá thì mỗi lần retry là một
   * khoá mới → trừ credit hai lần. Webhook idempotency không cứu được ca này.
   */
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;
}
