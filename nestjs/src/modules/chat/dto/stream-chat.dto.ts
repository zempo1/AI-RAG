import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ChatDto } from './chat.dto';

export class StreamChatDto extends ChatDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chatId?: number | null;
}
