import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChatDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
