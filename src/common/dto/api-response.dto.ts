import { ApiProperty } from "@nestjs/swagger";

export class ApiResponse<T> {
  @ApiProperty({ example: 200 })
  statusCode: number;

  @ApiProperty({ example: "Operation completed successfully" })
  message: string;

  @ApiProperty()
  data: T;

  constructor(statusCode: number, message: string, data: T) {
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }
}
