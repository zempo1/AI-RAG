import { IsOptional, IsString, IsInt, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class ChatDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) knowledgeBaseId?: number;
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  question?: string;
}
