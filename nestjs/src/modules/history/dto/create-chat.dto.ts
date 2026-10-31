import { IsOptional, IsString, MaxLength, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChatDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) knowledgeBaseId?: number;
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
