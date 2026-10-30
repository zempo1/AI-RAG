import { IsOptional, IsString } from 'class-validator';

export class ChatDto {
  @IsOptional()
  @IsString()
  question?: string;
}
